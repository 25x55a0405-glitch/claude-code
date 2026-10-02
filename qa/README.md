# Sky QA

Tests from the testing thread. They don't change the UI or server code; they run
against it. Tests named "BUG n" fail until the bug in [BUGS.md](BUGS.md) is fixed.

```
qa/run-server.sh   # API checks, in-process (needs `npm install` in server/)
qa/run-e2e.sh      # builds web/, starts throwaway servers, drives the real UI in Chromium
```

The browser tests need the web app that matches the server. Run them on a
checkout that has both the UI branch and the back-end branch merged.

- `server/contract.test.ts`: API behaviour against docs/API.md and docs/BACKEND.md,
  including Stars, using the server's own test helpers.
- `server/round3.test.ts`: model providers and fallback, the Stars' real browser,
  and wave 1 (lessons, secrets, push). Stand-in providers and pages run as local
  HTTP servers, since outside sites are blocked.
- `server/round4.test.ts`: wave 2. Triggers and webhooks, Telegram and Slack
  (stand-ins, with a real WebSocket server for Slack), each Star's address on a
  fake Gmail, MCP tools (`server/fixtures/mcp-stub.mjs`, a local MCP server),
  group chats and templates.
- `server/round5.test.ts`: wave 4 and a security sweep. Voice with stand-in
  speech providers, the real companion program (`companion/sky-companion.mjs`)
  with its own settings file, the checkout handover and teach-a-task recordings
  on local shop pages in real Chromium, key presses, edited approvals and the
  sandbox's mounts.
- `e2e/server.ts`: the real server with an in-memory database, the model router
  (on the scripted brain until a test adds a provider), real Chromium for the
  Stars' browser, the built web app at `/`, a fake Gmail so approvals can be tested end to end,
  and a fake Telegram for pairing.
- `e2e/ui.test.mjs`: Playwright tests of the real UI against that server. Uses the
  globally installed `playwright`; set `PLAYWRIGHT_FROM` to another
  `node_modules` folder if yours is elsewhere.

Browser parts use Chromium at `/opt/pw-browsers/chromium`; set `QA_CHROMIUM` to
use another one.
