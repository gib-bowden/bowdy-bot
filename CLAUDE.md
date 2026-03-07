# Bowdy Bot

Family AI assistant for the Bowden household — manages tasks, groceries, calendar, reminders, and general chat.

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript, ESM (`"type": "module"`)
- **AI**: Anthropic Claude SDK (claude-sonnet-4-6) with tool_use for routing; Claude Haiku for GroupMe message classification + morning briefing generation
- **Scheduling**: node-schedule for cron jobs (morning briefing) and date-based scheduling (reminders)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Platforms**: Console (default), Telegram (grammy), Twilio SMS, GroupMe
- **Calendar**: Google Calendar API via `googleapis` package (OAuth 2.0)
- **Grocery**: Google Tasks (list management, cart tracking) + Kroger API (product search, cart sync, product preferences)
- **Skills**: Anthropic Skills API — syncs local skill definitions for code execution

## Project Structure

```
src/
  index.ts              # Entry point — registers modules, syncs skills, selects platform, starts bot
  config.ts             # Env var loading (required/optional helpers)
  logger.ts             # Pino logger
  ai/
    client.ts           # Anthropic client singleton (shared by router + GroupMe classifier)
    router.ts           # AIRouter — Claude streaming + tool execution loop (skills, web search, code execution)
  db/
    client.ts           # SQLite connection (getDb(), schema exports)
    schema.ts           # Drizzle schema (users, googleAccounts, krogerAccounts, productPreferences, reminders, conversationHistory)
    migrate.ts          # Schema migration (ensureSchema())
    conversation.ts     # Conversation history — load/save per-user message history (max 30 messages)
  auth/
    google.ts           # Google OAuth account management (token encrypt/decrypt)
    kroger.ts           # Kroger OAuth + API client (client credentials + user auth)
    crypto.ts           # AES-256-GCM token encryption at rest
    server.ts           # OAuth callback HTTP server (Google + Kroger routes)
  modules/
    types.ts            # Module<T> generic interface: { name, description, tools, executeTool }
    registry.ts         # ModuleRegistry — registers modules, routes tool calls
    google-tasks/       # Google Tasks backend (list management, grocery lists)
    kroger/             # Kroger product search, Google Tasks cart tracking, product preferences
      index.ts          # 8 tools: search, set store, send to cart, preference CRUD
      api.ts            # Kroger API client (search products, locations, add to cart)
      cart.ts           # Google Tasks "Kroger Cart" list operations (async)
      preferences.ts    # Product preference DB operations (lookup, save, list, delete)
    calendar/           # Google Calendar module (list, create, delete events)
    gmail/              # Email triage module (scan, classify, summarize, action)
      triage.ts         # Triage scan + email composition with action buttons
      classify.ts       # Email classification via Claude Haiku
      actions.ts        # Shared action executor (archive, keep, unsubscribe, spam) + HMAC URL signing
      action-handler.ts # HTTP webhook handler for one-click triage action buttons
      api.ts            # Gmail API client (list, archive, trash, send, labels)
      rules.ts          # Email auto-archive rules (domain, sender, subject matching)
    reminders/          # Reminder tools (create, list, cancel) — SQLite + node-schedule
    chat/               # Fallback chat module (no tools)
  cron/
    scheduler.ts        # startScheduler() — morning briefing cron + reminder recovery on startup
    morning-briefing.ts # Pulls today's calendar + tasks, Claude Haiku summary, posts to GroupMe
    reminders.ts        # scheduleReminder(), cancelScheduledReminder(), recoverReminders()
  skills/
    manager.ts          # Syncs skill definitions from skills/ dir to Anthropic API
  platform/
    types.ts            # Platform interface
    console.ts          # Console (stdin/stdout) adapter
    telegram.ts         # Telegram adapter (long-polling via grammy)
    twilio.ts           # Twilio SMS adapter (HTTP webhook + REST API)
    groupme.ts          # GroupMe adapter — LLM classifier + message buffer + @mention detection
```

## Key Patterns

- **Module interface**: `Module<T>` is generic over a tool→input type map. Each module defines typed input interfaces per tool, combines them into a map type (e.g. `CalendarInputs`), and exports as `Module<CalendarInputs>`. Register in `src/index.ts` via `registry.register(module)`.
- **Tool routing**: Claude IS the router. No intent matching — Claude sees all tool descriptions and picks the right one.
- **Optional modules**: Some modules (e.g. calendar, kroger) only register if their config is present. Check config values before registering.
- **Config**: `required()` throws on missing env vars, `optional()` provides defaults. Optional features use `process.env["KEY"] ?? ""` and check truthiness before use.
- **Input typing**: Each module defines typed input interfaces (e.g. `CreateEventInput`) and a `*Inputs` map type. Helper functions accept typed inputs directly. The `executeTool` switch casts `input as SpecificInput` at each case (TS can't narrow generics via switch). External callers get full type safety on tool name + input shape.
- **File extensions**: Always use `.js` extensions in imports (ESM requirement even for .ts files).
- **Conversation history**: Loaded per-user before each AI request, saved after response. Max 30 messages (15 exchanges) per user via `src/db/conversation.ts`.
- **GroupMe message classification**: Three-tier system — (1) fast-path regex for explicit "bowdy" mentions, (2) @mention detection via GroupMe attachments, (3) Claude Haiku classifier with recent message buffer context. See `src/platform/groupme.ts`.
- **Product preferences**: Maps generic grocery item names to specific Kroger products (UPC, brand, size). Used by `send_to_kroger_cart` to auto-select familiar items without re-searching.
- **Kroger cart tracking**: Uses a dedicated "Kroger Cart" Google Tasks list. Tasks have formatted titles (`"Product Name (x2)"`) and JSON metadata notes (`{"item":"eggs","upc":"123","product_id":"456"}`). Cart operations are async and visible in the Google Tasks app.
- **Triage action buttons**: When `PUBLIC_URL` is set, triage emails include clickable action buttons (Archive, Keep, Unsubscribe) per item. Buttons are `<a>` tags linking to `GET /triage/action?session={id}&item={ref}&action={action}&sig={hmac}`. The webhook handler (`action-handler.ts`) validates the HMAC signature, executes the action via the shared executor (`actions.ts`), and returns an HTML confirmation page. HMAC uses `TOKEN_ENCRYPTION_KEY` as the secret, signing `sessionId:itemRef:action`.
- **Skills**: Optional. Read from `skills/` directory (one subdirectory per skill with `SKILL.md`). Synced to Anthropic API on startup (best-effort, continues on failure). Enables code execution tool in router.
- **Proactive features**: Morning briefing (daily cron) and reminders (exact-time scheduling) run as in-process scheduled jobs via `node-schedule`. Both send messages to GroupMe via exported `sendGroupMeMessage()`. The scheduler starts in `src/index.ts` when `GROUPME_BOT_ID` is set.
- **Reminder recovery**: On startup, `recoverReminders()` queries unfired reminders from SQLite and re-schedules them (or fires immediately if overdue). This handles process restarts gracefully.

## Cart System

The Kroger cart uses Google Tasks for persistence instead of SQLite, making items visible in the Google Tasks app:

- **List**: "Kroger Cart" (auto-created)
- **Task format**:
  - Title: `Kroger Grade A Large Eggs, 12 ct (x2)` (product name + quantity suffix if > 1)
  - Notes: `{"item":"eggs","upc":"0001111060932","product_id":"0001111060932"}`
- **Operations**: `addCartItem()`, `isInCart()`, `getCartSummary()`, `clearCart()` (all async)
- **Flow**: Items sent to Kroger's cart are also added as tasks. Users can see the cart in Google Tasks. `clearCart()` deletes all tasks.

## Commands

```bash
npx tsx src/index.ts    # Dev mode
npx tsc --noEmit        # Type-check
npm run build           # Production build (tsup)
npm start               # Run production build
npm run build && npm start  # Smoke-test production bundle before pushing
npx vitest run          # Run tests (co-located *.test.ts files next to source)
```

## Environment Variables

Required: `ANTHROPIC_API_KEY`

Optional: `PLATFORM`, `TELEGRAM_BOT_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_ALLOWLIST`, `TWILIO_WEBHOOK_PORT`, `GROUPME_BOT_ID`, `GROUPME_BOT_USER_ID` (enables @mention detection), `GROUPME_WEBHOOK_PORT`, `LOG_LEVEL`, `DB_PATH`, `TZ`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_PORT`, `GOOGLE_CALENDAR_ID`, `TOKEN_ENCRYPTION_KEY` (required when Google OAuth or Kroger is enabled; generate with `openssl rand -hex 32`), `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_OAUTH_REDIRECT_URI`, `ENABLE_MORNING_BRIEFING` (default `"true"`), `MORNING_BRIEFING_HOUR` (0-23, default `"8"`), `ENABLE_BROWSER` (default `"false"` — requires Playwright/Chromium installed), `PUBLIC_URL` (e.g. `https://bowdy.example.com` — enables clickable action buttons in triage emails)

See `.env.example` for full list with defaults.
