import assert from "node:assert/strict";
import test from "node:test";
import { compose, inside, manifest } from "../src/setup-files.ts";

test("paths cannot escape the mounted directory", () => {
  assert.equal(inside("/setup", "repo"), "/setup/repo");
  assert.throws(() => inside("/setup", "../secrets"));
  assert.throws(() => inside("/setup", "/elsewhere"));
});

test("manifest names are escaped as YAML strings", () => {
  const output = manifest("name: Skill Issue\ndisplay_name: skill-issue", 'Bot: "release"\nother: value');
  assert.equal(output.split("\n").length, 2);
  assert.ok(output.includes('name: "Bot: \\"release\\"\\nother: value"'));
});

test("Compose preserves dollar signs and mounts only selected folders", () => {
  const output = compose({ repository: "my repo", auth: "api", botToken: "xoxb-test", appToken: "xapp-test", apiKey: "sk-ant-$example" }, "bot config", 1234, 5678);
  assert.ok(output.includes('user: "1234:5678"'));
  assert.ok(output.includes("sk-ant-$$example"));
  assert.ok(output.includes("./my repo:/workspace:ro"));
  assert.ok(output.includes("./bot config:/claude-home"));
  const subscription = compose({ repository: null, auth: "subscription", botToken: "xoxb-test", appToken: "xapp-test" }, "skill-issue", 1000, 1000);
  assert.ok(!subscription.includes("ANTHROPIC_API_KEY"));
  assert.ok(!subscription.includes(":/workspace:ro"));
  assert.ok(subscription.includes("/workspace:uid=1000,gid=1000,mode=0700"));
});
