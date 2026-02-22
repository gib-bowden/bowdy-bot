# Bowdy Bot

Family AI assistant for the Bowden household — manages tasks, groceries, calendar, and general chat.

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript, ESM (`"type": "module"`)
- **AI**: Anthropic Claude SDK (claude-sonnet-4-20250514) with tool_use for routing
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Platforms**: Console (default), Telegram (grammy)
- **Calendar**: Google Calendar API via `googleapis` package (service account auth)

## Project Structure

```
src/
  index.ts          # Entry point — registers modules, selects platform, starts bot
  config.ts         # Env var loading (required/optional helpers)
  logger.ts         # Pino logger
  ai/
    router.ts       # AIRouter — Claude streaming + tool execution loop
  db/
    client.ts       # SQLite connection (getDb(), schema exports)
    schema.ts       # Drizzle schema (users, tasks, conversationHistory)
    migrate.ts      # Schema migration (ensureSchema())
  modules/
    types.ts        # Module interface: { name, description, tools, executeTool }
    registry.ts     # ModuleRegistry — registers modules, routes tool calls
    tasks/          # Task & grocery list module
    calendar/       # Google Calendar module (list, create, delete events)
    chat/           # Fallback chat module (no tools)
  platform/
    types.ts        # Platform interface
    console.ts      # Console (stdin/stdout) adapter
    telegram.ts     # Telegram adapter (long-polling via grammy)
```

## Key Patterns

- **Module interface**: Each module exports `{ name, description, tools: Anthropic.Tool[], executeTool(name, input) }`. Register in `src/index.ts` via `registry.register(module)`.
- **Tool routing**: Claude IS the router. No intent matching — Claude sees all tool descriptions and picks the right one.
- **Optional modules**: Some modules (e.g. calendar) only register if their config is present. Check config values before registering.
- **Config**: `required()` throws on missing env vars, `optional()` provides defaults. Optional features use `process.env["KEY"] ?? ""` and check truthiness before use.
- **Input typing**: Tool inputs arrive as `Record<string, unknown>` — cast inside handler functions.
- **File extensions**: Always use `.js` extensions in imports (ESM requirement even for .ts files).

## Commands

```bash
npx tsx src/index.ts    # Dev mode
npx tsc --noEmit        # Type-check
npm run build           # Production build (tsup)
npm start               # Run production build
```

## Environment Variables

Required: `ANTHROPIC_API_KEY`

Optional: `PLATFORM`, `TELEGRAM_BOT_TOKEN`, `LOG_LEVEL`, `DB_PATH`, `TZ`, `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, `GOOGLE_CALENDAR_ID`

See `.env.example` for full list with defaults.
