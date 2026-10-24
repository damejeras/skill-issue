import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { App, type webApi } from "@slack/bolt";
import { hasSession, send, sessionIdFor, type Content, type Listener } from "./session.ts";

// Node 24 names its main thread MainThread, and top and ps show that name for the process.
process.title = "skill-issue";

type SlackFile = { id: string; name: string | null; size: number; url_private?: string };

type Incoming = {
  team: string;
  channel: string;
  ts: string;
  threadTs: string;
  user: string;
  text: string;
  files: SlackFile[];
};

// Uploads live in the config folder so that a resumed session still finds them after a restart.
const UPLOADS_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? "/claude-home", "uploads");
// An unfinished wizard can contain Slack tokens; do not start sessions until it is cleaned up.
for (const name of [".skill-issue-setup.json", ".skill-issue-setup.json.tmp"]) {
  try {
    await access(join(process.env.CLAUDE_CONFIG_DIR ?? "/claude-home", name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  console.error("Finish the setup wizard before starting the bot; its saved state still contains credentials.");
  process.exit(1);
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// The markdown_text limit of chat.postMessage.
const MAX_REPLY_CHARS = 12_000;
// agents.sessions.setStatus drops "processing" after one hour.
const HEARTBEAT_MS = 30 * 60 * 1000;

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
if (!botToken || !appToken) {
  console.error("Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN.");
  process.exit(1);
}

const app = new App({ token: botToken, appToken, socketMode: true });

const splitReply = (text: string) => {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_REPLY_CHARS) {
    const newline = rest.lastIndexOf("\n", MAX_REPLY_CHARS);
    const cut = newline > 0 ? newline : MAX_REPLY_CHARS;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return [...parts, rest];
};

const listenerFor = (client: webApi.WebClient, channel: string, threadTs: string): Listener => {
  let heartbeat: NodeJS.Timeout | undefined;
  const setStatus = (status: "processing" | "active") =>
    client.agents.sessions
      .setStatus({ channel_id: channel, thread_ts: threadTs, status })
      .catch((error) => console.error(`setStatus ${status} failed`, error));
  const stopWorking = async () => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    await setStatus("active");
  };
  const post = async (markdown: string) => {
    for (const part of splitReply(markdown)) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, markdown_text: part });
    }
  };
  const postError = () =>
    post("Error: Claude could not finish this turn. The bot log has the details.").catch((error) =>
      console.error("posting the error failed", error),
    );

  return {
    busy: () => {
      setStatus("processing");
      heartbeat = setInterval(() => setStatus("processing"), HEARTBEAT_MS);
    },
    result: async (result, idle) => {
      if (idle) await stopWorking();
      if (result.subtype !== "success" || result.is_error) {
        console.error("turn failed", result);
        await postError();
        return;
      }
      if (!result.result.trim()) return;
      await post(result.result).catch((error) => console.error("posting the reply failed", error));
    },
    ended: async (error) => {
      console.error("Claude session ended", error);
      await stopWorking();
      await postError();
    },
  };
};

const attach = async (files: SlackFile[], sessionId: string) => {
  const saved: string[] = [];
  const skipped: string[] = [];
  const dir = join(UPLOADS_DIR, sessionId);
  for (const file of files) {
    const name = file.name ?? "unnamed file";
    if (!file.url_private) skipped.push(`${name} (no download link)`);
    else if (saved.length >= MAX_FILES) skipped.push(`${name} (more than ${MAX_FILES} files)`);
    else if (file.size > MAX_FILE_BYTES) skipped.push(`${name} (larger than 20 MB)`);
    else {
      const response = await fetch(file.url_private, { headers: { Authorization: `Bearer ${botToken}` } });
      // Slack answers a download it refuses with an HTML login page and status 200.
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok || bytes.length !== file.size) {
        skipped.push(`${name} (download failed)`);
        continue;
      }
      const path = join(dir, `${file.id}-${name.replaceAll("/", "_")}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      saved.push(path);
    }
  }
  return { saved, skipped };
};

// Slack sends one mention as both app_mention and message, and redelivers events it thinks were lost.
const seen = new Set<string>();
const SEEN_MS = 10 * 60 * 1000;

const engage = async (client: webApi.WebClient, message: Incoming) => {
  const key = `${message.channel}:${message.ts}`;
  if (seen.has(key)) return;
  seen.add(key);
  setTimeout(() => seen.delete(key), SEEN_MS);

  const sessionId = sessionIdFor(message.team, message.channel, message.threadTs);
  const [{ user }, { saved, skipped }] = await Promise.all([
    client.users.info({ user: message.user }),
    attach(message.files, sessionId),
  ]);
  const name = user?.real_name || user?.name || message.user;
  const notes = [
    ...(saved.length > 0 ? [`[Files attached, read them with the Read tool: ${saved.join(", ")}]`] : []),
    ...(skipped.length > 0 ? [`[Files not attached: ${skipped.join(", ")}]`] : []),
  ];
  const content: Content = [{ type: "text", text: [`<@${message.user}> (${name}): ${message.text}`, ...notes].join("\n") }];
  send(
    sessionId,
    content,
    listenerFor(client, message.channel, message.threadTs),
  );
};

app.event("app_mention", async ({ event, body, client }) => {
  if (!event.user || event.bot_id) return;
  await engage(client, {
    team: body.team_id,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    user: event.user,
    text: event.text,
    files: event.files ?? [],
  });
});

app.message(async ({ message, body, client, context }) => {
  if (message.subtype !== undefined && message.subtype !== "file_share" && message.subtype !== "thread_broadcast") return;
  if (("bot_id" in message && message.bot_id) || !message.thread_ts) return;
  if (message.text?.includes(`<@${context.botUserId}>`)) return;
  const threadTs = message.thread_ts;
  if (!(await hasSession(sessionIdFor(body.team_id, message.channel, threadTs)))) return;
  await engage(client, {
    team: body.team_id,
    channel: message.channel,
    ts: message.ts,
    threadTs,
    user: message.user,
    text: message.text ?? "",
    files: ("files" in message && message.files) || [],
  });
});

await app.start();
console.log("Slack bot is running.");
