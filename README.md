# containerclaude

A container that runs a Claude Code session for each Slack thread.
The app moves messages between Slack and Claude, and nothing more.
The files in `claude-home/` set what Claude can do: `settings.json`, `CLAUDE.md`, `skills/`, `agents/` and MCP servers.

## Run

1. Create a Slack app from `slack-manifest.yaml` at https://api.slack.com/apps ("From a manifest").
2. Install the app to the workspace. Copy the bot token (`xoxb-…`).
3. Under "Basic Information", make an app-level token with the `connections:write` scope. Copy it (`xapp-…`).
4. Write the two tokens to `.env`:

   ```sh
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_APP_TOKEN=xapp-…
   ```

5. Make the config folder. The container user has UID 1000, so the folder must be writable by UID 1000:

   ```sh
   mkdir claude-home
   ```

6. Log in to your Claude subscription one time. The command prints a URL; open it and paste the code back:

   ```sh
   docker compose run --rm bot claude auth login
   ```

7. Start the bot:

   ```sh
   docker compose up -d --build
   ```

8. Invite the bot to a channel and mention it.

To give Claude a project, mount it at `/workspace` in `compose.yaml`.

## Cost

Each Slack turn uses the quota of the Claude subscription that is logged in.

## Security

The Bash sandbox stops shell commands from reading `claude-home/.credentials.json`, but Claude's other tools, such as Read, can still read it.
