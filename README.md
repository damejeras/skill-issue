# skill-issue

A container that runs a Claude Code session for each Slack thread.
The app moves messages between Slack and Claude, and nothing more.
The files in `/claude-home` set what Claude can do: `settings.json`, `CLAUDE.md`, `skills/`, `agents/` and MCP servers.

## Run

From the folder containing your repositories, run the setup wizard:

```sh
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/setup" \
  ghcr.io/damejeras/skill-issue setup
```

It asks where to keep the bot's configuration (default `./skill-issue`), its name,
and whether to mount a repository. Folder selection uses the bundled fuzzy finder;
paths are relative to the folder you mounted. Repository access is read only. Without a repository, the bot gets a writable
scratch workspace in memory; its contents are discarded when the container stops.
The wizard generates a Slack manifest and guides you through creating the app,
entering its tokens, and signing in to Claude or supplying an Anthropic API key.

Answers are saved after each step. If you cancel, run the same command and choose
the same configuration folder to resume without re-entering saved tokens.
Tokens are visible while you type and support normal cursor movement and editing.
Choose “Edit saved tokens” when resuming or “Change tokens” before finishing to
correct an earlier entry.
On completion, the wizard writes `compose.yaml` with your tokens and removes its
intermediate setup file. Existing Compose files are only replaced with confirmation.

Then start the bot:

```sh
docker compose up -d
```

Invite the bot to a Slack channel and mention it. Each thread gets its own session.
To update, run `docker compose pull && docker compose up -d`.

The setup command and generated Compose use your host UID and GID so files remain
writable on Linux. On SELinux hosts, the setup bind mount may need `:Z`; apply the
same label to the generated bind mounts. Docker Desktop handles host file ownership
through its file sharing layer.

## Give your bot a job

The configuration folder is mounted at `/claude-home`. It follows Claude Code's
normal structure:

```text
skill-issue/
  CLAUDE.md
  settings.json
  skills/
    investigate-issue/
      SKILL.md
    prepare-release/
      SKILL.md
```

Put the bot's standing instructions in `CLAUDE.md` and reusable workflows in
`skills/<name>/SKILL.md`. Each skill's description tells Claude when to use it;
one bot can serve several purposes depending on the request in a Slack thread.
Skills can include scripts and reference files alongside `SKILL.md`.
Sessions, uploads, and subscription credentials also live in this configuration folder.

## Manual setup

You can still create a Slack app from [`slack-manifest.yaml`](slack-manifest.yaml)
and use [`compose.yaml`](compose.yaml) directly. Set `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN`, and optionally `ANTHROPIC_API_KEY`. For subscription login, run:

```sh
docker compose run --rm bot claude auth login
```

Mount a repository at `/workspace` and a dedicated configuration folder at
`/claude-home`, or keep the template's named volume. A host folder must be writable
by the container user (UID 1000 by default, or the `user:` you configure).

## Cost

Each Slack turn is billed to the Claude subscription or to the Anthropic API key.

## Security

The Bash sandbox removes `ANTHROPIC_API_KEY` from shell commands, but Claude's other tools, such as Read, run outside the sandbox and can still reach the key, for example in `/proc/self/environ`.
Anyone who can write in a channel with the bot can make Claude run commands and read every file in the container.

Generated `compose.yaml` contains runtime tokens. Keep it outside the mounted
repository and out of version control. The wizard refuses repositories containing
its configuration folder. Its temporary `.skill-issue-setup.json` contains secrets
until setup completes; keep that folder private. Setup-created secret files use
mode `0600` and new configuration folders use `0700`. Existing folders' permissions
are left unchanged.
