# Bowdy Bot

Family AI assistant for the Bowden household. Chat naturally to manage tasks, groceries, calendars, and more — powered by Claude.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

### Setup

```bash
# Install dependencies
npm install

# Create your environment file
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Run (Console Mode)

```bash
npx tsx src/index.ts
```

Type messages in your terminal and chat with the bot. Try things like:

- "Add milk to the grocery list"
- "What's on my grocery list?"
- "Mark milk as done"
- "Add a task to call the dentist"

## Platforms

### Console (Default)

No extra setup needed. Set `PLATFORM=console` in `.env` (or leave it blank — console is the default).

### Telegram

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create a bot
3. Copy the bot token BotFather gives you
4. Update `.env`:
   ```
   PLATFORM=telegram
   TELEGRAM_BOT_TOKEN=your-bot-token-here
   ```
5. Run the bot: `npx tsx src/index.ts`
6. Open your bot in Telegram and start chatting

The bot uses long-polling, so it works without a public URL or webhook setup.

### iMessage (macOS only)

Send texts to the bot from your iPhone via iMessage — no extra apps needed.

**Requirements**: macOS with Messages.app signed into iMessage.

**One-time macOS permissions**:
1. **Full Disk Access** — System Settings > Privacy & Security > Full Disk Access > add Terminal (or whichever app runs the bot). Required to read `chat.db`.
2. **Automation** — The first time the bot sends a reply, macOS will prompt to allow Terminal to control Messages.app. Approve it once.

**Setup**:
1. Update `.env`:
   ```
   PLATFORM=imessage
   IMESSAGE_ALLOWLIST=+16155551234,wife@gmail.com
   ```
2. Run the bot: `npx tsx src/index.ts`
3. Send an iMessage to the Mac from an allowlisted phone number or email
4. The bot reads the message, processes it through Claude, and replies via iMessage

The allowlist is a comma-separated list of phone numbers (with country code) and/or email addresses. Only messages from these senders are processed — all others are silently ignored.

Group chats are supported. If someone in the allowlist sends a message in a group chat, the bot will reply to that group chat.

### WhatsApp (Planned)

WhatsApp integration is on the roadmap. The likely approach:

- **WhatsApp Business API** via [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/) — requires a Meta Business account and a verified phone number
- **Alternative**: A third-party bridge like [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) for personal accounts (less reliable, against WhatsApp ToS)

When implemented, it will follow the same adapter pattern as Telegram — a new file at `src/platform/whatsapp.ts` implementing the `Platform` interface, selectable via `PLATFORM=whatsapp` in `.env`.

## Modules

### Tasks & Groceries

Manage to-do lists and grocery lists with natural language:

| What you can say | What happens |
|---|---|
| "Add eggs to the grocery list" | Adds "eggs" to the grocery list |
| "I need to call the vet" | Adds to the general task list |
| "What's on my grocery list?" | Shows all open grocery items |
| "Show me all my tasks" | Shows everything across all lists |
| "Mark eggs as done" | Completes the matching item |

Tasks are stored in a local SQLite database at `data/bowdy-bot.db`.

### Calendar

Google Calendar integration via a GCP service account. Supports viewing, creating, and deleting events:

| What you can say | What happens |
|---|---|
| "What's on our calendar this week?" | Lists events for the next 7 days |
| "What do we have next month?" | Lists events for the next 30 days |
| "Schedule a dentist appointment Thursday at 2pm" | Creates a calendar event |
| "Cancel the dentist appointment" | Finds and deletes the matching event |

#### Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com), create a project (or use an existing one)
2. Enable the **Google Calendar API** (APIs & Services > Library > search "Google Calendar API")
3. Create a **Service Account** (APIs & Services > Credentials > Create Credentials > Service Account)
4. Create a key for the service account (Keys tab > Add Key > JSON) and save the downloaded file somewhere safe:
   ```bash
   mkdir -p ~/.config/bowdy-bot
   mv ~/Downloads/your-project-*.json ~/.config/bowdy-bot/google-service-account.json
   ```
5. Copy the service account email from the credentials page (looks like `xxx@project.iam.gserviceaccount.com`)
6. In [Google Calendar settings](https://calendar.google.com/calendar/r/settings), find your shared family calendar, go to "Share with specific people", and add the service account email with **"Make changes to events"** permission
7. Still in calendar settings, copy the **Calendar ID** (under "Integrate calendar" — for the primary calendar of a Gmail account, it's the Gmail address)
8. Add to your `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=~/.config/bowdy-bot/google-service-account.json
   GOOGLE_CALENDAR_ID=family@gmail.com
   ```

The calendar module only loads when both env vars are set. If they're missing, the bot runs fine without calendar features.

### General Chat

Anything that isn't a task or calendar request gets a normal conversational response from Claude. Ask questions, get recommendations, brainstorm — whatever you need.

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `PLATFORM` | No | `console` | `console`, `telegram`, or `imessage` |
| `TELEGRAM_BOT_TOKEN` | If telegram | — | Bot token from @BotFather |
| `IMESSAGE_ALLOWLIST` | If imessage | — | Comma-separated phone numbers/emails |
| `IMESSAGE_CHAT_DB_PATH` | No | `~/Library/Messages/chat.db` | Path to iMessage database |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `DB_PATH` | No | `./data/bowdy-bot.db` | Path to SQLite database file |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | No | — | Path to GCP service account JSON key |
| `GOOGLE_CALENDAR_ID` | No | — | Google Calendar ID (e.g. Gmail address) |

## API Costs

The bot uses `claude-sonnet-4-20250514`. Typical family usage costs pennies per day:

- Each message exchange: ~$0.01–0.05
- $5–10 of credit will last a long time
- Set up [usage alerts](https://console.anthropic.com/settings/limits) on the Anthropic dashboard so you don't get surprised

If your balance runs out, the bot will fail to respond until you top up — it won't crash or lose data.

## Development

```bash
# Run in dev mode
npx tsx src/index.ts

# Type-check
npx tsc --noEmit

# Build for production
npm run build

# Run production build
npm start
```

### Adding a New Module

1. Create a folder under `src/modules/your-module/`
2. Export a `Module` object with `name`, `description`, `tools`, and `executeTool`
3. Register it in `src/index.ts`:
   ```ts
   import { yourModule } from "./modules/your-module/index.js";
   registry.register(yourModule);
   ```

Claude automatically discovers and routes to your module's tools — no intent matching or routing config needed.

## Architecture

```
Chat Platform (Console / Telegram / iMessage / WhatsApp)
       ↓ normalized IncomingMessage
AI Router (Claude with tool_use)
       ↓ tool calls
Module System (Tasks, Calendar, Chat)
       ↓
SQLite via Drizzle ORM
```

Claude IS the router. Modules register tools with descriptions, and Claude decides which to call based on the user's message. No hand-rolled intent matching.

## Roadmap

- [x] Console chat platform
- [x] Task & grocery list management
- [x] Telegram integration
- [x] iMessage integration (macOS)
- [ ] Conversation history / context window
- [x] Google Calendar integration
- [ ] WhatsApp adapter
- [ ] Recurring tasks
- [ ] Family communication topics
- [ ] Webhook mode (for production hosting)
