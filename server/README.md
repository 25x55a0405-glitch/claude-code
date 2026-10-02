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

Models: add any OpenAI-compatible or Anthropic-compatible provider in the app
(OpenRouter, Groq, Gemini, Mistral, Ollama, …) and order them; Sky falls back
along the list when one is rate limited, out of quota or down. An
`ANTHROPIC_API_KEY` in the environment shows up as a built-in provider.

The browser is a real Chromium driven by Playwright (`playwright-core`). On a
new machine install it once with `npx playwright install chromium`, or point
`SKY_BROWSER_PATH` at Chrome (or set `SKY_BROWSER_CHANNEL=chrome`).

With no provider at all the server still runs, on a small scripted stand-in for the
model. It can set up tasks, reminders and watches, remember things and walk
through approvals, but it doesn't really think. It's what the tests use.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | | Adds Claude as a built-in model provider |
| `SKY_MODEL` | `claude-opus-5-5` | Model for that built-in provider |
| `SKY_EFFORT` | `medium` | `low` to `max`; more effort thinks harder and costs more |
| `SKY_FALLBACKS` | on | `0` turns off the API's server-side refusal fallback |
| `SKY_BRAIN` | auto | `scripted` forces the offline stand-in |
| `SKY_BROWSER_HEADLESS` | `1` | `0` shows the browser window, e.g. to sign in on a desktop |
| `SKY_BROWSER_PATH` | Playwright's Chromium | Use another Chrome or Chromium |
| `SKY_BROWSER_CHANNEL` | | `chrome` or `msedge` to use the installed browser |
| `SKY_BROWSER_PROFILE` | `DATA_DIR/browser-profile` | Where cookies and sign-ins are kept |
| `SKY_BROWSER_PROXY` | | Proxy for the browser, like `http://user:pass@host:port` |
| `PORT` | `8787` | |
| `SKY_HOST` | `127.0.0.1` (`0.0.0.0` when a password is set) | |
| `SKY_DATA_DIR` | `./data` | Where `sky.db` lives, and `secret.key` when `SKY_SECRET_KEY` isn't set (back it up) |
| `SKY_SECRET_KEY` | | Passphrase the secrets vault's key is made from. Without it a random key file is created |
| `SKY_PASSWORD` | | Turns on sign-in. Visit `/login` once; the browser keeps a session cookie |
| `SKY_API_TOKEN` | | Bearer token for scripts, accepted alongside the password |
| `SKY_PUBLIC_URL` | `http://localhost:PORT` | This server's public URL, used for OAuth redirects |
| `SKY_WEB_ORIGIN` | | Web app origin(s) allowed to call the API (comma-separated). Writes from any other site are refused, so a web app on another address, like the Vite dev server without its proxy, must be listed here |
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
| Slack | For two-way chat, nothing: make an app from the manifest at `/api/v1/messaging/slack/manifest` and paste its tokens in the app. For posting only: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`; `SKY_SLACK_NOTIFY_CHANNEL` to get updates there | same |
| Telegram | Nothing: connect a @BotFather bot in the app and pair it with the code. Or `SKY_TELEGRAM_BOT_TOKEN`, `SKY_TELEGRAM_CHAT_ID` | |

Until they're set, "Connect" in the app explains which variables are missing.

The older `SKYS_*` names still work.

## Develop

```
npm test           # 53 tests: API contract, agent behaviour, Stars, model fallback, real browser, schedules
npm run typecheck
npm run dev        # restarts on change
```
