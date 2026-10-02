# Sky server

The back end for Sky: the REST and live-events API the web app talks to
(see [`docs/API.md`](../docs/API.md)), plus the always-on Stars (Sky's agents)
that run tasks, ask and hand work to each other, waits for approvals, keeps to schedules, writes the daily briefing,
suggests ideas and does proactive research. How it fits together is in
[`docs/BACKEND.md`](../docs/BACKEND.md).

## Run it

Needs Node 22.18 or newer (it runs TypeScript directly and stores data with
the built-in SQLite).

```
cd server
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start        # http://127.0.0.1:8787/api/v1
```

Then point the web app at it:

```
cd web
VITE_SKYS_API_URL=http://localhost:8787 npm run dev
SKY_WEB_ORIGIN=http://localhost:5173 npm start   # in server/, so the browser may call it
```

Or serve both from one place: build the web app with
`VITE_SKYS_API_URL= npm run build` and the server serves `web/dist` at `/`.

Without an API key the server still runs, on a small scripted stand-in for the
model. It can set up tasks, reminders and watches, remember things and walk
through approvals, but it doesn't really think. It's what the tests use.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | Turns on the real agent (Claude) |
| `SKY_MODEL` | `claude-opus-5-5` | Model for chat, tasks, research and ideas |
| `SKY_EFFORT` | `medium` | `low` to `max`; more effort thinks harder and costs more |
| `SKY_FALLBACKS` | on | `0` turns off the API's server-side refusal fallback |
| `SKY_BRAIN` | auto | `scripted` forces the offline stand-in |
| `PORT` | `8787` | |
| `SKY_HOST` | `127.0.0.1` (`0.0.0.0` when a password is set) | |
| `SKY_DATA_DIR` | `./data` | Where `sky.db` lives |
| `SKY_PASSWORD` | | Turns on sign-in. Visit `/login` once; the browser keeps a session cookie |
| `SKY_API_TOKEN` | | Bearer token for scripts, accepted alongside the password |
| `SKY_PUBLIC_URL` | `http://localhost:PORT` | This server's public URL, used for OAuth redirects |
| `SKY_WEB_ORIGIN` | | Web app origin(s) allowed to call the API with cookies (comma-separated) |
| `SKY_WEB_URL` | web origin or public URL | Where to send people after OAuth or sign-in |
| `SKY_USER_NAME` | `there` | Name used until it's changed in Settings |
| `SKY_TICK_MS` | `15000` | How often the clock checks schedules and expiries |
| `SKY_MAX_STEPS` | `24` | Model turns per task run before it stops |
| `SKY_RESEARCH_EVERY_MIN` | `240` | Minimum gap between proactive research rounds |

### Connecting apps

The web browser connection works out of the box (Claude's web search and
fetch). The others need credentials on the server:

| App | Set | Redirect URL to register |
| --- | --- | --- |
| Gmail, Calendar, Drive | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `SKY_PUBLIC_URL/api/v1/oauth/callback` |
| GitHub | `SKY_GITHUB_TOKEN` (personal token), or `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | same |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | same |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`; `SKY_SLACK_NOTIFY_CHANNEL` to get updates there | same |
| Telegram | `SKY_TELEGRAM_BOT_TOKEN`, `SKY_TELEGRAM_CHAT_ID` | |

Until they're set, "Connect" in the app explains which variables are missing.

The older `SKYS_*` names still work.

## Develop

```
npm test           # 44 tests: API contract, agent behaviour, Stars, schedules, Claude request shape
npm run typecheck
npm run dev        # restarts on change
```
