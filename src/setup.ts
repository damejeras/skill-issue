import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, access, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { compose, inside, manifest, type Setup } from "./setup-files.ts";

const root = process.env.SETUP_DIR ?? "/setup";
const stateName = ".skill-issue-setup.json";
let rl: ReturnType<typeof createInterface> | undefined;
const reader = () => rl ??= createInterface({ input: process.stdin, output: process.stdout });
const closeReader = () => { rl?.close(); rl = undefined; };

async function ask(question: string, fallback = "") {
  const answer = (await reader().question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer || fallback;
}

async function choose(question: string, choices: string[]) {
  console.log(`\n${question}`);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}${index === 0 ? " (default)" : ""}`));
  for (;;) {
    const answer = await ask("Choose", "1");
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return index;
    console.log("Enter one of the numbers above.");
  }
}

async function token(question: string, prefix: string, current = "") {
  for (;;) {
    const input = reader();
    const answer = input.question(`${question}: `);
    input.write(current);
    const value = (await answer).trim();
    if (value.startsWith(prefix) && !/\s/.test(value)) return value;
    console.log(`Expected a token starting with ${prefix}.`);
    current = value;
  }
}

async function editTokens(state: Setup, save: () => Promise<void>) {
  const fields = [
    { key: "botToken", label: "Bot token", prefix: "xoxb-" },
    { key: "appToken", label: "App-level token", prefix: "xapp-" },
    { key: "apiKey", label: "Anthropic API key", prefix: "sk-ant-" },
  ] as const;
  for (;;) {
    const saved = fields.filter((field) => state[field.key]);
    const choice = await choose("Which token do you want to change?", [...saved.map((field) => field.label), "Back"]);
    if (choice === saved.length) return;
    const field = saved[choice];
    state[field.key] = await token(field.label, field.prefix, state[field.key]);
    await save();
  }
}

async function directories(dir = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "vendor"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    result.push(relative(root, path));
    try { result.push(...await directories(path)); } catch { /* Skip inaccessible subdirectories. */ }
  }
  return result;
}

async function folder() {
  closeReader();
  const paths = [".", ...await directories()].sort();
  if (spawnSync("fzf", ["--version"], { stdio: "ignore" }).status !== 0) {
    return await ask("Folder relative to the working directory", ".");
  }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("fzf", ["--prompt=Folder > ", "--height=80%", "--reverse"], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("Selection cancelled. Rerun setup to continue.")));
    child.stdin.end(paths.join("\n"));
  });
}

async function atomic(path: string, contents: string) {
  const temp = `${path}.tmp`;
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}

async function exists(path: string) {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function checkedPath(path: string): Promise<string> {
  const absolute = inside(root, path);
  let ancestor = absolute;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  const realRoot = await realpath(root);
  inside(realRoot, await realpath(ancestor));
  return absolute;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup needs an interactive terminal. Run docker with --rm -it.");
  process.umask(0o077);
  await access(root, constants.W_OK);
  console.log("Set up your Slack assistant. Paths are relative to the directory mounted at /setup.");
  const configChoice = await choose("Where should the bot keep its configuration?", ["./skill-issue", "Choose an existing folder…", "Enter another path…"]);
  const configPath = await checkedPath(configChoice === 0 ? "skill-issue" : configChoice === 1 ? await folder() : await ask("Configuration folder"));
  if (configPath === root) throw new Error("Choose a dedicated configuration subfolder, rather than the mounted root.");
  await mkdir(configPath, { recursive: true, mode: 0o700 });
  await access(configPath, constants.W_OK);
  const statePath = join(configPath, stateName);
  let state: Setup = {};
  const resuming = await exists(statePath);
  if (resuming) {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (!state || typeof state !== "object" ||
      Object.entries(state).some(([key, value]) => !["name", "repository", "botToken", "appToken", "auth", "apiKey"].includes(key) ||
        (typeof value !== "string" && !(key === "repository" && value === null))) ||
      (state.auth !== undefined && !["subscription", "api"].includes(state.auth))) {
      throw new Error("The saved setup file is invalid. Correct it or remove it to start again.");
    }
    console.log(`\nResuming setup${state.name ? ` for ${state.name}` : ""}. Saved tokens will not be displayed.`);
  }
  const save = () => atomic(statePath, JSON.stringify(state, null, 2) + "\n");
  if (resuming && (state.botToken || state.appToken || state.apiKey) &&
    await choose("Resume setup?", ["Continue setup", "Edit saved tokens"]) === 1) {
    await editTokens(state, save);
  }
  if (!state.name) { state.name = await ask("Bot name", "Skill Issue"); await save(); }
  if (state.repository === undefined) {
    if (await choose("Give the bot access to a repository?", ["No repository", "Choose a folder…"]) === 0) state.repository = null;
    else {
      const path = await checkedPath(await folder());
      if (!(await stat(path)).isDirectory()) throw new Error("The repository must be a directory.");
      // A parent mount would expose wizard state and Claude credentials through /workspace.
      const rel = relative(path, configPath);
      if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Choose a repository that does not contain the bot configuration folder.");
      state.repository = relative(root, path) || ".";
    }
    await save();
  }
  if (!state.botToken) {
    console.log("\nOpen https://api.slack.com/apps → Create New App → From a manifest.\nChoose your workspace, select YAML, and paste this manifest:\n");
    console.log(manifest(await readFile(new URL("../slack-manifest.yaml", import.meta.url), "utf8"), state.name));
  }
  if (!state.botToken) {
    console.log("Install the app to your workspace. Under OAuth & Permissions, copy the Bot User OAuth Token.");
    state.botToken = await token("Bot token", "xoxb-"); await save();
  }
  if (!state.appToken) {
    console.log("Under Basic Information → App-Level Tokens, generate a token with connections:write.");
    state.appToken = await token("App-level token", "xapp-"); await save();
  }
  const authEnv: NodeJS.ProcessEnv = { ...process.env, HOME: configPath, CLAUDE_CONFIG_DIR: configPath };
  delete authEnv.ANTHROPIC_API_KEY;
  delete authEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete authEnv.ANTHROPIC_AUTH_TOKEN;
  if (!state.auth) {
    state.auth = await choose("How should Claude authenticate?", ["Claude subscription", "Anthropic API key"]) === 0 ? "subscription" : "api";
    await save();
  }
  if (state.auth === "api" && !state.apiKey) { state.apiKey = await token("Anthropic API key", "sk-ant-"); await save(); }
  if (state.auth === "subscription") {
    const status = () => spawnSync("claude", ["auth", "status"], { env: authEnv, stdio: "ignore" }).status === 0;
    if (!status()) {
      closeReader();
      console.log("\nSign in to Claude. Open the URL printed by Claude in your browser and follow its prompts.");
      const login = spawnSync("claude", ["auth", "login"], { env: authEnv, stdio: "inherit" });
      if (login.status !== 0 || !status()) throw new Error("Claude login did not complete. Rerun setup to retry without re-entering Slack tokens.");
    }
    console.log("✓ Claude is signed in.");
  }
  if (state.repository !== null) {
    const repo = await checkedPath(state.repository!);
    if (!(await stat(repo)).isDirectory()) throw new Error("The saved repository is no longer a directory.");
    const rel = relative(await realpath(repo), await realpath(configPath));
    if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("The repository must not contain the bot configuration folder.");
  }
  const config = relative(root, configPath);
  console.log(`\nBot: ${state.name}\nConfiguration: ./${config}\nRepository: ${state.repository === null ? "none" : `./${state.repository} (read only)`}\nSlack tokens: saved\nClaude: ${state.auth}`);
  for (;;) {
    const choice = await choose("Ready to write compose.yaml?", ["Finish setup", "Change tokens", "Save and exit"]);
    if (choice === 0) break;
    if (choice === 2) return;
    await editTokens(state, save);
  }
  const composePath = join(root, "compose.yaml");
  if (await exists(composePath) && await choose("compose.yaml already exists. Replace it?", ["Keep it and exit", "Replace it"]) === 0) return;
  // Refuse to put the final secrets into the selected repository mount.
  if (state.repository === ".") throw new Error("The repository mount would expose compose.yaml and its tokens. Choose a repository subfolder.");
  await mkdir(join(configPath, "skills"), { recursive: true, mode: 0o700 });
  await atomic(composePath, compose(state, config, process.getuid!(), process.getgid!()));
  await rm(statePath);
  await rm(`${statePath}.tmp`, { force: true });
  console.log(`\n✓ Setup complete.\n\nStart your bot:\n  docker compose up -d\n\nInvite ${state.name} to a Slack channel and mention it.\nAdd skills in ./${config}/skills/<name>/SKILL.md\nAdd standing instructions in ./${config}/CLAUDE.md`);
}

try { await main(); } catch (error) {
  console.error(`\n${error instanceof Error ? error.message : "Setup failed."}`);
  process.exitCode = 1;
} finally { closeReader(); }
