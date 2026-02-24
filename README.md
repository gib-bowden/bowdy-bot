# Bowdy Bot

Family AI assistant for the Bowden household. Chat naturally to manage tasks, groceries, calendars, and more — powered by Claude.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
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

### Twilio SMS

SMS via a dedicated Twilio phone number. Works on any server — not tied to macOS like iMessage.

**Setup**:

1. Create a [Twilio account](https://www.twilio.com/) and buy a phone number (~$1.50/month)
2. In the Twilio console, set the number's "A message comes in" webhook to `https://your-server:3000/` (POST)
3. Update `.env`:
   ```
   PLATFORM=twilio
   TWILIO_ACCOUNT_SID=ACxxxxx
   TWILIO_AUTH_TOKEN=your-auth-token
   TWILIO_PHONE_NUMBER=+16155551234
   TWILIO_ALLOWLIST=+16155559999:Gib,+16155558888:Mary Becker
   ```
4. Run the bot: `npx tsx src/index.ts`
5. Text the Twilio number from an allowlisted phone

The allowlist works the same as iMessage — comma-separated `phone:Name` pairs. Only allowlisted senders get responses; others are silently ignored. Long messages are automatically split at ~1500 characters for readability.

For local development, use [ngrok](https://ngrok.com/) to expose the webhook port: `ngrok http 3000`.

### GroupMe

Group chat via a GroupMe bot. Free, instant setup — no phone number or approval needed. The bot lives in a GroupMe group and responds to all messages from group members.

#### 1. Create a GroupMe Bot

1. Open [dev.groupme.com](https://dev.groupme.com/) and sign in with your GroupMe account
2. Click **Bots** in the top nav
3. Click **Create Bot**
4. Fill in the form:
   - **Group**: Select the family group chat (or create one first in the GroupMe app)
   - **Name**: Whatever you want the bot to appear as (e.g. "Bowdy")
   - **Callback URL**: Leave blank for now — you'll set this after deploying
   - **Avatar URL**: Optional — paste a URL to an image for the bot's avatar
5. Click **Submit**
6. On the next page, copy the **Bot ID** (a long alphanumeric string)

#### 2. Configure Environment

Update your `.env`:

```
PLATFORM=groupme
GROUPME_BOT_ID=your-bot-id-here
```

#### 3. Test Locally

```bash
# Start the bot
npx tsx src/index.ts

# In another terminal, expose the webhook with ngrok
ngrok http 3000
```

Copy the ngrok HTTPS URL (e.g. `https://abc123.ngrok-free.app`) and go back to [dev.groupme.com](https://dev.groupme.com/) → **Bots** → click your bot → **Edit** → paste the URL into **Callback URL** → **Submit**.

Send a message in the GroupMe group — the bot should respond.

#### 4. Deploy to Railway

For always-on hosting:

1. In the [Railway dashboard](https://railway.com/), set these environment variables:
   ```
   PLATFORM=groupme
   GROUPME_BOT_ID=your-bot-id-here
   ANTHROPIC_API_KEY=sk-ant-...
   DB_PATH=/data/bowdy-bot.db
   TZ=America/Chicago
   ```
2. Deploy and copy the Railway public URL from the **Settings** → **Networking** → **Public Networking** section (generate a domain if needed)
3. Go to [dev.groupme.com](https://dev.groupme.com/) → **Bots** → click your bot → **Edit**
4. Set **Callback URL** to your Railway URL (e.g. `https://bowdy-bot-production.up.railway.app`)
5. **Submit** — messages in the group now route to the deployed bot

#### Notes

- **Group-only**: GroupMe bots can only read and post in the group they're created for — no DMs
- **No allowlist needed**: Group membership is the access control
- **Loop prevention**: Bot messages (`sender_type === "bot"`) and system messages are automatically ignored
- **Message splitting**: Long responses are split at ~1000 characters (GroupMe's limit) at natural break points

### WhatsApp (Planned)

WhatsApp integration is on the roadmap. The likely approach:

- **WhatsApp Business API** via [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/) — requires a Meta Business account and a verified phone number
- **Alternative**: A third-party bridge like [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) for personal accounts (less reliable, against WhatsApp ToS)

When implemented, it will follow the same adapter pattern as Telegram — a new file at `src/platform/whatsapp.ts` implementing the `Platform` interface, selectable via `PLATFORM=whatsapp` in `.env`.

## Modules

### Tasks & Groceries

Manage to-do lists and grocery lists with natural language. The grocery list lives in **Google Tasks** (visible in the Google Tasks app), with optional **Kroger integration** for product search and cart sync.

| What you can say               | What happens                                       |
| ------------------------------ | -------------------------------------------------- |
| "Add eggs to the grocery list" | Adds "eggs" to the grocery list (Google Tasks)     |
| "I need to call the vet"       | Adds to the general task list                      |
| "What's on my grocery list?"   | Shows all open grocery items                       |
| "Show me all my tasks"         | Shows everything across all lists                  |
| "Mark eggs as done"            | Completes the matching item                        |
| "Search Kroger for chicken"    | Searches products at your preferred Kroger store   |
| "Send groceries to Kroger"     | Pushes grocery list items to your Kroger cart       |

When Google OAuth is configured, tasks and groceries are managed via Google Tasks. When Kroger is also configured, you get product search and cart sync on top — the two work together.

### Calendar & Google Tasks

Google Calendar and Tasks integration via OAuth 2.0. Supports viewing, creating, and deleting events, plus managing task lists through Google Tasks.

| What you can say                                 | What happens                         |
| ------------------------------------------------ | ------------------------------------ |
| "What's on our calendar this week?"              | Lists events for the next 7 days     |
| "What do we have next month?"                    | Lists events for the next 30 days    |
| "Schedule a dentist appointment Thursday at 2pm" | Creates a calendar event             |
| "Cancel the dentist appointment"                 | Finds and deletes the matching event |

#### Setup

##### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project (or select an existing one)
2. Go to **APIs & Services > Library** and enable:
   - **Google Calendar API**
   - **Google Tasks API**

##### 2. Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**
2. Select **External** user type (unless you have a Google Workspace org) and click **Create**
3. Fill in the required fields — app name, user support email, and developer contact email. The rest can be left blank.
4. On the **Scopes** step, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/tasks`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
5. On the **Test users** step, add the Google accounts you'll connect (e.g. your family Gmail addresses). While the app is in "Testing" mode, only these accounts can sign in.
6. Click **Save and Continue** through the rest

##### 3. Create OAuth credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Select **Web application** as the application type
4. Under **Authorized redirect URIs**, add: `http://localhost:3001/oauth/callback`
5. Click **Create** and copy the **Client ID** and **Client Secret**

##### 4. Configure environment

Generate an encryption key for storing tokens at rest:

```bash
openssl rand -hex 32
```

Add to your `.env`:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALENDAR_ID=family@gmail.com
GOOGLE_TOKEN_ENCRYPTION_KEY=your-64-char-hex-key
```

##### 5. Connect your Google account

1. Start the bot — an OAuth server runs at `http://localhost:3001`
2. Visit `http://localhost:3001` and sign in with your Google account
3. The first connected account becomes the default for Calendar and Tasks

The calendar and tasks modules only load when Google OAuth is configured. If the vars are missing, the bot runs fine without these features. OAuth tokens are encrypted at rest using AES-256-GCM.

### Kroger Integration

Optional product search and cart sync. The grocery list stays in Google Tasks — Kroger adds the ability to search for products at your local store and push your grocery list to the Kroger app cart when you're ready to shop.

#### Setup

1. Create an app at [developer.kroger.com](https://developer.kroger.com)
2. Add `http://localhost:3001/kroger/callback` as an authorized redirect URI
3. Add to your `.env`:
   ```
   KROGER_CLIENT_ID=your-kroger-client-id
   KROGER_CLIENT_SECRET=your-kroger-client-secret
   ```
4. Start the bot and visit `http://localhost:3001/kroger/start` to connect your Kroger account
5. Tell the bot your zip code to set your preferred store ("Set my Kroger store to 37201")

The Kroger module only loads when `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` are set. It registers alongside Google Tasks — not as a replacement.

### General Chat

Anything that isn't a task or calendar request gets a normal conversational response from Claude. Ask questions, get recommendations, brainstorm — whatever you need.

## Configuration

All configuration is via environment variables (`.env` file):

| Variable                          | Required    | Default               | Description                                                    |
| --------------------------------- | ----------- | --------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`               | Yes         | —                     | Your Anthropic API key                                         |
| `PLATFORM`                        | No          | `console`             | `console`, `telegram`, `twilio`, or `groupme`                  |
| `TELEGRAM_BOT_TOKEN`              | If telegram | —                     | Bot token from @BotFather                                      |
| `TWILIO_ACCOUNT_SID`              | If twilio   | —                     | Twilio Account SID                                             |
| `TWILIO_AUTH_TOKEN`               | If twilio   | —                     | Twilio Auth Token                                              |
| `TWILIO_PHONE_NUMBER`             | If twilio   | —                     | Bot's Twilio phone number                                      |
| `TWILIO_ALLOWLIST`                | If twilio   | —                     | Comma-separated `phone:Name` pairs                             |
| `TWILIO_WEBHOOK_PORT`             | No          | `3000`                | Port for incoming SMS webhooks                                 |
| `GROUPME_BOT_ID`                  | If groupme  | —                     | Bot ID from dev.groupme.com                                    |
| `GROUPME_WEBHOOK_PORT`            | No          | `3000`                | Port for incoming GroupMe webhooks                             |
| `LOG_LEVEL`                       | No          | `info`                | `debug`, `info`, `warn`, `error`                               |
| `DB_PATH`                         | No          | `./data/bowdy-bot.db` | Path to SQLite database file                                   |
| `GOOGLE_CLIENT_ID`                | No          | —                     | Google OAuth 2.0 client ID                                     |
| `GOOGLE_CLIENT_SECRET`            | No          | —                     | Google OAuth 2.0 client secret                                 |
| `GOOGLE_OAUTH_REDIRECT_URI`      | No          | `http://localhost:3001/oauth/callback` | OAuth callback URL                              |
| `GOOGLE_OAUTH_PORT`              | No          | `3001`                | Port for the OAuth callback server                             |
| `GOOGLE_CALENDAR_ID`              | No          | —                     | Google Calendar ID (e.g. Gmail address)                        |
| `TOKEN_ENCRYPTION_KEY`            | If Google/Kroger OAuth | —            | 32-byte hex key for token encryption (`openssl rand -hex 32`)  |
| `KROGER_CLIENT_ID`                | No          | —                     | Kroger API client ID (from developer.kroger.com)               |
| `KROGER_CLIENT_SECRET`            | No          | —                     | Kroger API client secret                                       |
| `KROGER_OAUTH_REDIRECT_URI`      | No          | `http://localhost:3001/kroger/callback` | Kroger OAuth callback URL                     |

## Deploying to Railway

[Railway](https://railway.com/) provides push-to-deploy hosting with persistent volumes for the SQLite database.

1. Push the repo to GitHub
2. Sign up at [railway.com](https://railway.com/) and connect your GitHub repo
3. Add a **volume** mounted to `/data` (for the SQLite database)
4. Set environment variables in the Railway dashboard:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   PLATFORM=twilio
   TWILIO_ACCOUNT_SID=ACxxxxx
   TWILIO_AUTH_TOKEN=...
   TWILIO_PHONE_NUMBER=+16155551234
   TWILIO_ALLOWLIST=+16155559999:Gib,+16155558888:Mary Becker
   DB_PATH=/data/bowdy-bot.db
   TZ=America/Chicago
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_CALENDAR_ID=family@gmail.com
   GOOGLE_TOKEN_ENCRYPTION_KEY=your-64-char-hex-key
   GOOGLE_OAUTH_REDIRECT_URI=https://your-app.up.railway.app/oauth/callback
   # Optional: Kroger integration
   KROGER_CLIENT_ID=your-kroger-client-id
   KROGER_CLIENT_SECRET=your-kroger-client-secret
   KROGER_OAUTH_REDIRECT_URI=https://your-app.up.railway.app/kroger/callback
   ```
5. Deploy — Railway builds the Docker image and starts the container
6. Copy the Railway public URL and set it as the Twilio webhook URL (POST) for your phone number
7. Add the Railway URL to your Google OAuth credentials:
   - Go to [Google Cloud Console](https://console.cloud.google.com) > **APIs & Services > Credentials**
   - Edit your OAuth client ID
   - Add `https://your-app.up.railway.app/oauth/callback` as an **Authorized redirect URI**
8. Visit `https://your-app.up.railway.app/` to connect your Google account

Railway automatically assigns a `PORT` env var. When using Twilio or GroupMe, the OAuth routes are served on the same port as the webhook — no extra port configuration needed.

## API Costs

The bot uses `claude-sonnet-4-6`. Typical family usage costs pennies per day:

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
Chat Platform (Console / Telegram / Twilio SMS / GroupMe / WhatsApp)
       ↓ normalized IncomingMessage
AI Router (Claude with tool_use)
       ↓ tool calls
Module System (Tasks, Calendar, Kroger, Chat)
       ↓                          ↓
SQLite via Drizzle ORM    External APIs (Google, Kroger)
```

Claude IS the router. Modules register tools with descriptions, and Claude decides which to call based on the user's message. No hand-rolled intent matching.

## Roadmap

- [x] Console chat platform
- [x] Task & grocery list management
- [x] Telegram integration
- [x] Twilio SMS integration
- [x] GroupMe integration
- [ ] Conversation history / context window
- [x] Google Calendar integration
- [x] Kroger product search + cart sync
- [ ] WhatsApp adapter
- [ ] Recurring tasks
- [ ] Family communication topics
- [ ] Webhook mode (for production hosting)
