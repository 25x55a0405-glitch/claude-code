# Skys bugs found in testing

Found on 2026-10-02 by running the real web app against the real server (scripted
brain, no API key) in Chromium, and by API checks against docs/API.md and
docs/BACKEND.md. Each bug has a test that fails today and passes once it's fixed.
The testing thread reports these; the UI and back-end threads own the fixes.

Baseline: the server's own 33 tests pass, `tsc` is clean in `server/`, and the web
app builds. Chat, memory, goals, pause, approvals (approve and decline), settings,
ideas and phone layout all work end to end.

## UI (web/)

### 1. The app opens too many event streams and freezes (high)

Every `useResource(..., reloadOn)` and `useLiveEvents` call opens its own
`EventSource` (`web/src/api/http.ts` `subscribe`). The chat screen holds 5 at once.
Browsers allow 6 connections per host over HTTP/1.1, and an open event stream
holds one for good. So:

- Opening the profile sheet makes 6, and from then on every API call in the page
  hangs (no messages, no approvals, nothing loads).
- Opening Skys in a second tab does the same: the second tab never loads data.

Fix idea: open one `EventSource` in `createHttpApi` and fan events out to
subscribers. Tests: `qa/e2e/ui.test.mjs` "BUG 1" (three tests).

### 2. Server errors are swallowed (medium)

`Chat.send`, `TaskDetail.command` and `ApprovalCard.decide` have no `catch`. When
the server says no (a 400, or a 409 like "This was already approved" from another
device), the user sees nothing. In chat the typing indicator then stays on forever.
docs/API.md says the UI shows `error.message`. Test: "BUG 2" sends a message over
the 20,000 character limit.

### 3. No way to sign in (medium)

With `SKYS_PASSWORD` set, the app loads as an empty chat with a "?" avatar. Every
call gets a 401 and nothing tells the user to sign in or links to `/login`.
Fix idea: on a 401, go to `/login` (same origin) or show a sign-in prompt.
Test: "BUG 3".

## Server (server/)

### 4. A reply cut off by a restart stays "streaming" forever (medium)

`ChatAgent.replyNow` saves the reply as `streaming` before it starts. If the server
stops mid-reply, it comes back as an empty `streaming` message that never finishes,
and the user's message never gets an answer. Fix idea: on start, mark leftover
`streaming` messages as `error` (or re-run the reply). Test: `qa/server/contract.test.ts` "BUG 4".

### 5. Run now brings back a task you stopped (low)

`POST /tasks/:id/run_now` on a task stopped with `cancel` (status `done`) returns
200 and sets it back to `active`, so it runs again. It should be a 409 like the
other commands on finished tasks. The UI hides the button on finished tasks, so
this is API-only today. Test: "BUG 5".

### 6. A malformed URL is a 500 (low)

`GET /api/v1/tasks/%E0%A4%A` throws `URIError` in `Router.match` and returns 500
"Something went wrong". Should be a 400. Test: "BUG 6".

### 7. A garbled activity cursor returns an empty page (low)

`GET /activity?cursor=!!!` decodes to `0` and returns 200 with no items, instead
of the 400 that `cursor=abc` gets. Test: "BUG 7".

### 8. PATCH /settings accepts a body that isn't an object (low)

`null`, `[]`, `"x"` or `5` return 200 and change nothing. Should be a 400. Test: "BUG 8".

## Not tested

- Real Claude: there's no `ANTHROPIC_API_KEY` here, so everything ran on the scripted brain.
- Real OAuth apps: Gmail was faked in-process; no Google, GitHub, Notion or Slack calls.
- Approval expiry after 24 hours and schedules across days (the server's own tests cover the schedule maths).
