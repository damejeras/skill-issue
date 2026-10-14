# skill-issue

A container that runs a Claude Code session for each Slack thread.
The app moves messages between Slack and Claude, and nothing more.
The files in `/claude-home` set what Claude can do: `settings.json`, `CLAUDE.md`, `skills/`, `agents/` and MCP servers.

## Run

1. Create a Slack app from [`slack-manifest.yaml`](slack-manifest.yaml) at https://api.slack.com/apps ("From a manifest").
2. Install the app to the workspace.
3. Under "Basic Information", make an app-level token with the `connections:write` scope.
4. Download `compose.yaml` into a new folder:

   ```sh
   mkdir skill-issue && cd skill-issue
   curl -fsSLO https://raw.githubusercontent.com/damejeras/skill-issue/main/compose.yaml
   ```

5. In `compose.yaml`, fill in the bot token and the app-level token.
   To bill an API key, set `ANTHROPIC_API_KEY` too, and skip the next step.
6. To use a Claude subscription, sign in. The login is kept in the `claude-home` volume:

   ```sh
   docker compose run --rm bot claude auth login
   ```

7. Start the bot:

   ```sh
   docker compose up -d
   ```

   This pulls `ghcr.io/damejeras/skill-issue` for `linux/amd64` or `linux/arm64`.
   To update, run `docker compose pull && docker compose up -d`.

8. Invite the bot to a channel and mention it.

To give Claude a project, mount it at `/workspace` in `compose.yaml`.
Sessions and uploads are kept in the `claude-home` Docker volume.
To edit the files in `/claude-home` from the host, mount a folder there instead of the volume. The container user has UID 1000, so the folder must be writable by UID 1000.

## Cost

Each Slack turn is billed to the Claude subscription or to the Anthropic API key.

## Security

The Bash sandbox removes `ANTHROPIC_API_KEY` from shell commands, but Claude's other tools, such as Read, run outside the sandbox and can still reach the key, for example in `/proc/self/environ`.
Anyone who can write in a channel with the bot can make Claude run commands and read every file in the container.
