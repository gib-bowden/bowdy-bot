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

### Calendar (Planned)

Google Calendar integration is on the roadmap. Will support:

- "What's on our calendar this week?"
- "Schedule a dentist appointment for Thursday at 2pm"
- "When are we both free this weekend?"

This will require Google OAuth2 or a service account with access to your family calendar.

### General Chat

Anything that isn't a task or calendar request gets a normal conversational response from Claude. Ask questions, get recommendations, brainstorm — whatever you need.

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `PLATFORM` | No | `console` | `console` or `telegram` |
| `TELEGRAM_BOT_TOKEN` | If telegram | — | Bot token from @BotFather |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `DB_PATH` | No | `./data/bowdy-bot.db` | Path to SQLite database file |

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
Chat Platform (Console / Telegram / WhatsApp)
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
- [ ] Conversation history / context window
- [ ] Google Calendar integration
- [ ] WhatsApp adapter
- [ ] Recurring tasks
- [ ] Family communication topics
- [ ] Webhook mode (for production hosting)
