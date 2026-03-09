# Bowdy Bot

Family AI assistant for the Bowden household — manages tasks, groceries, calendar, reminders, browser automation, and general chat.

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript, ESM (`"type": "module"`)
- **AI**: Claude Sonnet (router), Claude Haiku (browser actor, GroupMe classifier, morning briefing)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Platforms**: Console (default), Telegram (grammy), Twilio SMS, GroupMe
- **Browser**: Camoufox (Firefox-based, anti-detection) via playwright-core — vision-driven agent loop
- **APIs**: Google Calendar, Google Tasks, Gmail, Kroger, Anthropic Skills

## Project Structure

```
src/
  index.ts              # Entry point — registers modules, selects platform
  config.ts             # Env var loading (required/optional helpers)
  ai/
    client.ts           # Anthropic client singleton
    router.ts           # AIRouter — streaming + tool execution loop
  db/                   # SQLite: schema, migrations, conversation history
  auth/                 # Google OAuth, Kroger OAuth, token encryption
  modules/
    types.ts            # Module<T> generic interface
    registry.ts         # ModuleRegistry — registers modules, routes tool calls
    google-tasks/       # Task/grocery list management
    kroger/             # Product search, cart sync, product preferences
    calendar/           # Google Calendar (list, create, delete events)
    gmail/              # Email triage (scan, classify, action buttons)
    browser/            # Camoufox web automation
      agent.ts          # Vision agent loop, busy lock, conversation state
      actions.ts        # Action executor + URL validation (SSRF protection)
      session.ts        # Camoufox lifecycle (lazy launch, inactivity timeout)
      eval/             # Eval system — see eval/eval.test.ts for details
    reminders/          # SQLite + node-schedule
    chat/               # Fallback (no tools)
  cron/                 # Morning briefing, reminder scheduling/recovery
  skills/               # Anthropic Skills API sync
  platform/             # Console, Telegram, Twilio, GroupMe adapters
```

## Conventions

- **Module pattern**: `Module<T>` generic over tool→input type map. Register in `src/index.ts`. Optional modules gate on config presence.
- **Tool routing**: Claude IS the router — no intent matching. Tool descriptions drive selection.
- **Prompting**: System prompts stay thin (identity + context). Avoid anti-instructions. Describe what tools do, not what other tools shouldn't do.
- **File extensions**: Always `.js` in imports (ESM requirement even for .ts files).
- **Input typing**: `executeTool` switch casts `input as SpecificInput` per case (TS can't narrow generics via switch).

## Commands

```bash
npx tsx src/index.ts              # Dev mode
npx tsc --noEmit                  # Type-check
npm run build                     # Production build (tsup)
npm start                         # Run production build
npm run build && npm start        # Smoke-test before pushing
npx vitest run                    # Run tests
npm run eval                      # Browser agent evals (real API calls)
npm run eval:e2e                  # E2E browser evals (live sites, real API)
                                  # Filter: EVAL_SCENARIOS=resy-booking-vague npm run eval:e2e
```

## Environment Variables

Required: `ANTHROPIC_API_KEY`

Optional: `PLATFORM`, `TELEGRAM_BOT_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_ALLOWLIST`, `TWILIO_WEBHOOK_PORT`, `GROUPME_BOT_ID`, `GROUPME_BOT_USER_ID`, `GROUPME_WEBHOOK_PORT`, `LOG_LEVEL`, `DB_PATH`, `TZ`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_OAUTH_PORT`, `GOOGLE_CALENDAR_ID`, `TOKEN_ENCRYPTION_KEY`, `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_OAUTH_REDIRECT_URI`, `ENABLE_MORNING_BRIEFING` (default `"true"`), `MORNING_BRIEFING_HOUR`, `ENABLE_BROWSER` (default `"false"`), `BROWSER_EVAL_RECORD` (set `"1"` to capture eval fixtures), `EVAL_MODEL` (override browser agent model for evals), `PUBLIC_URL`

See `.env.example` for full list with defaults.
