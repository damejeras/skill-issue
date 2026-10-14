import { relative, resolve, sep } from "node:path";

export type Setup = {
  name?: string;
  repository?: string | null;
  botToken?: string;
  appToken?: string;
  auth?: "subscription" | "api";
  apiKey?: string;
};

export function inside(root: string, path: string) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Choose a path inside the mounted working directory.");
  }
  return absolute;
}

export function manifest(template: string, name: string) {
  return template
    .replace("name: Skill Issue", `name: ${JSON.stringify(name)}`)
    .replace("display_name: skill-issue", `display_name: ${JSON.stringify(name)}`);
}

// Compose interpolates dollar signs even in quoted YAML values.
const yaml = (value: string) => JSON.stringify(value.replaceAll("$", () => "$$"));

export function compose(state: Setup, config: string, uid: number, gid: number) {
  const volumes = [`./${config}:/claude-home`];
  if (state.repository !== null) volumes.push(`./${state.repository}:/workspace:ro`);
  return `services:
  bot:
    image: ghcr.io/damejeras/skill-issue:latest
    restart: unless-stopped
    user: "${uid}:${gid}"
    environment:
      SLACK_BOT_TOKEN: ${yaml(state.botToken!)}
      SLACK_APP_TOKEN: ${yaml(state.appToken!)}
${state.auth === "api" ? `      ANTHROPIC_API_KEY: ${yaml(state.apiKey!)}\n` : ""}    volumes:
${volumes.map((v) => `      - ${yaml(v)}`).join("\n")}
${state.repository === null ? `    tmpfs:\n      - /workspace:uid=${uid},gid=${gid},mode=0700\n` : ""}    security_opt:
      - seccomp=unconfined
      - systempaths=unconfined
`;
}
