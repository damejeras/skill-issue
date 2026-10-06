import {
  getSessionMessages,
  query,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { v5 as uuidv5 } from "uuid";

export type Content = Exclude<SDKUserMessage["message"]["content"], string>;

export type Listener = {
  busy: () => void;
  result: (result: SDKResultMessage, idle: boolean) => Promise<void>;
  ended: (error: unknown) => Promise<void>;
};

type LiveThread = {
  listener: Listener;
  push: (message: SDKUserMessage) => void;
  end: () => void;
  ended: boolean;
  pending: Set<string>;
  idle?: NodeJS.Timeout;
  done: Promise<void>;
};

const SESSION_NAMESPACE = "6f1c7a52-3d0e-4b8a-9f7e-2c5d8e1a4b90";
const IDLE_MS = 15 * 60 * 1000;

const { SLACK_BOT_TOKEN: _bot, SLACK_APP_TOKEN: _app, ...claudeEnv } = process.env;

const options: Options = {
  cwd: process.cwd(),
  env: claudeEnv,
  settingSources: ["user", "project"],
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  permissionPrompts: "none",
  disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: `You talk with people in a Slack thread.
Each message starts with the speaker's Slack mention and real name, for example "<@U012AB3CD> (Ada Lovelace): text".
Several people can write in the same thread.
Only the final text of each turn is posted to the thread.`,
  },
};

const live = new Map<string, LiveThread>();

export const sessionIdFor = (team: string, channel: string, threadTs: string) =>
  uuidv5(`${team}:${channel}:${threadTs}`, SESSION_NAMESPACE);

// getSessionInfo returns undefined for a transcript it cannot summarize, so it cannot tell whether one exists.
const hasTranscript = async (sessionId: string) =>
  (await getSessionMessages(sessionId, { dir: options.cwd, limit: 1 })).length > 0;

export const hasSession = async (sessionId: string) => live.has(sessionId) || (await hasTranscript(sessionId));

const start = (sessionId: string, listener: Listener, previous: Promise<void> | undefined): LiveThread => {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  async function* input() {
    for (;;) {
      const next = queue.shift();
      if (next) yield next;
      else if (thread.ended) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const run = async () => {
    // A thread that closed for idleness can still be shutting down; two processes must not share one transcript.
    await previous;
    try {
      const resume = await hasTranscript(sessionId);
      for await (const message of query({
        prompt: input(),
        options: { ...options, ...(resume ? { resume: sessionId } : { sessionId }) },
      })) {
        if (message.type !== "result") continue;
        for (const uuid of message.user_message_uuids ?? []) thread.pending.delete(uuid);
        const idle = thread.pending.size === 0;
        await listener.result(message, idle);
        if (idle) thread.idle = setTimeout(thread.end, IDLE_MS);
      }
      if (thread.pending.size > 0) await listener.ended(new Error("The Claude session ended before it answered."));
    } catch (error) {
      await listener.ended(error);
    } finally {
      thread.ended = true;
      clearTimeout(thread.idle);
      if (live.get(sessionId) === thread) live.delete(sessionId);
    }
  };

  const thread: LiveThread = {
    listener,
    push: (message) => {
      queue.push(message);
      wake?.();
    },
    end: () => {
      thread.ended = true;
      wake?.();
    },
    ended: false,
    pending: new Set(),
    done: Promise.resolve(),
  };
  thread.done = run();
  return thread;
};

export const send = (sessionId: string, content: Content, listener: Listener) => {
  let thread = live.get(sessionId);
  if (!thread || thread.ended) {
    thread = start(sessionId, listener, thread?.done);
    live.set(sessionId, thread);
  }
  if (thread.pending.size === 0) thread.listener.busy();
  const uuid = crypto.randomUUID();
  thread.pending.add(uuid);
  clearTimeout(thread.idle);
  thread.push({
    type: "user",
    uuid,
    origin: { kind: "human" },
    parent_tool_use_id: null,
    message: { role: "user", content },
  });
};
