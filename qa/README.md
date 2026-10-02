# Skys QA

Tests from the testing thread. They don't change the UI or server code; they run
against it. Tests named "BUG n" fail until the bug in [BUGS.md](BUGS.md) is fixed.

```
qa/run-server.sh   # API checks, in-process (needs `npm install` in server/)
qa/run-e2e.sh      # builds web/, starts throwaway servers, drives the real UI in Chromium
```

- `server/contract.test.ts`: API behaviour against docs/API.md and docs/BACKEND.md,
  using the server's own test helpers.
- `e2e/server.ts`: the real server with an in-memory database, the scripted brain,
  the built web app at `/`, and a fake Gmail so approvals can be tested end to end.
- `e2e/ui.test.mjs`: Playwright tests of the real UI against that server. Uses the
  globally installed `playwright`; set `PLAYWRIGHT_FROM` to another
  `node_modules` folder if yours is elsewhere.
