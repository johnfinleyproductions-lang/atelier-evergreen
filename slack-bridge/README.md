# Atelier Slack bridge

DM your Atelier team from Slack (and your phone). Socket Mode — no public URL needed.

## What it does
A Slack message → routed to Atelier's `/api/chat/<agent>` → the reply posts back.
Default agent is **Cleo**. Address others by prefix: `wren: 6 headlines for course 19`,
`hugo: build a pricing card`, `otto: is everything healthy?`.

## One-time Slack app setup (≈3 min, gets you 2 tokens)
1. Go to https://api.slack.com/apps → **Create New App** → From scratch → pick your workspace.
2. **Socket Mode** (left nav) → toggle **Enable Socket Mode** → it makes an **App-Level Token**
   with scope `connections:write` → copy it (starts `xapp-`). That's `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → Bot Token Scopes → add: `app_mentions:read`, `chat:write`,
   `im:history`, `im:read`, `im:write`, `channels:history`. Then **Install to Workspace** →
   copy the **Bot User OAuth Token** (starts `xoxb-`). That's `SLACK_BOT_TOKEN`.
4. **Event Subscriptions** → Enable → Subscribe to bot events: `message.im`, `app_mention`.
5. Save. (In Slack, open a DM with the app, or invite it to a channel.)

## Run it (on M90t)
Put the two tokens in `~/.config/atelier/slack.env`:
    SLACK_BOT_TOKEN=xoxb-...
    SLACK_APP_TOKEN=xapp-...
    ATELIER_URL=http://127.0.0.1:3040
Then enable the service:
    systemctl --user enable --now atelier-slack.service
