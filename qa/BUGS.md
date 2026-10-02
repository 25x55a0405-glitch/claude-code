# Sky bugs found in testing

Each bug has a test named "BUG n" that fails until it's fixed. The testing
thread reports these, and the UI and back-end threads own the fixes.

## Round 3 (2026-10-02): models, the live browser and wave 1

I tested the back-end branch (`aae76f7`) merged with the UI branch (`502d3a7`).
The back end's own 66 tests pass, and the web app builds and type-checks. All
three bugs from round 2 are fixed, and their tests now pass. Stand-in model
providers and web pages ran on this machine, since outside sites are blocked.

These work: adding providers on the Models screen, the Test button, chat falling
back past a broken provider, a provider that never answers or stops halfway
through a reply, and a provider that's rate limited still being tried when it's
the only one. Taking over the live browser pauses the Star, and handing back
wakes it. A correction in chat shows a lesson card, and Undo forgets it. The
secrets screen never shows a value, and the API never returns one. An ntfy
topic can be made and saved. All the wave 1 input checks I tried give 400s.

**The two bugs the design thread reported:** the bad address bug is real (bug
13). The lesson card is not a server bug. A correction makes a lesson and a card
every time, and in the browser the card shows up with a working Undo. One thing
that may explain what they saw: a correction is only learned when Sky has said
something before it, so a correction sent as the first message in a chat makes
no card. That's on purpose (`chat.ts` needs an earlier reply).

### 12. A model that never answers can freeze all of Sky's work (high, server)

The timeout only covers chat turns. `complete()` in `server/src/agent/openai.ts`
never passes an abort signal, and the router's timeout only gives up when the
call does. Rule checks, lessons, ideas and the briefing all use `complete()`.
With a provider that accepts the request but never replies, a task with a custom
rule stayed at "Working on Email Sam" with no approval, and the shared work
queue stopped. Fix idea: pass the router's signal to `complete()` the same way
`turn()` does. Test: `qa/server/round3.test.ts` "BUG 12".

### 13. A bad address in the live browser gives a server error (medium, server)

`POST /browser/:starId/input` with `navigate` returns 500 "Something went wrong
on the server" for any address that can't load: `data:`, `javascript:`, plain
text, or a closed port. `data:` text becomes `https://data:text/html,...`. Fix
idea: catch the `page.goto` error and return a 400 that says the page couldn't
load. Tests: "BUG 13" in `round3.test.ts` and `ui.test.mjs`.

### 14. A provider's API key leaks when the provider repeats it in an error (high, server)

Some providers echo the key back, for example `401 Invalid API key: sk-...`.
Sky passes the message on as is, so the full key shows up in the chat error, in
`GET /providers` (`health.lastError`), in the Test result, in `provider.updated`
events, in the server log, and on the Models screen. Fix idea: replace the
provider's key with `…last4` in every error message before it's stored or sent.
Also small: `keyHint` is the whole key when the key is 4 characters or shorter.
Tests: "BUG 14" in `round3.test.ts` and `ui.test.mjs`.

### 15. A secret used in a browsed address shows in plain text (high, server and UI)

When a Star opens `{{secret:API_TOKEN}}` in an address (after approval), the real
value shows in `GET /browser` (`sessions[].url`), in `browser.frame` events, and
in the live view's address bar. Task steps, activity, approvals, server logs and
what's sent to the model all stay clean. Fix idea: run `vault.redact()` on the
session's `url` and `title` in `BrowserManager.session()`. Test: "BUG 15".

### 16. Any web page can change Sky through the local API (high, server)

With no password, which is the default, a page on any site can send requests to
Sky's API. The server reads JSON whatever the content type says, and it never
checks where a request came from. So a `text/plain` request in `no-cors` mode
needs no permission from the browser. A test page on another port added the rule
"Send emails without asking", added a provider pointing at another server, added
a push subscription and paused Sky. Fix idea: require `Content-Type:
application/json` on writes, and refuse requests whose `Origin` or
`Sec-Fetch-Site` shows another site. Test: "BUG 16".

### 17. "Tool calling is not supported with this model" benches the provider for 6 hours (medium, server)

`classify()` in `server/src/models/registry.ts` treats any 400 that mentions the
model and says "not supported" or "invalid" as a broken provider. So "tool
calling is not supported with this model" or "Invalid value for max_tokens: too
large for this model" turns the provider off for 6 hours. The docs say a request
that doesn't suit a model should move on without benching it. Other wordings,
like "does not support tools", already move on correctly. Fix idea: only bench
on "model not found" style messages (unknown or retired model names). Test:
"BUG 17".

### 18. A secret shorter than 4 characters is never hidden (low, server)

The vault accepts a 3-character value such as a PIN, but `redact()` skips values
shorter than 4 characters, so it would show wherever redaction is relied on. Fix
idea: refuse values under 4 characters, or redact them too. Test: "BUG 18".

Also seen, small enough to leave without tests:
- A push subscription whose endpoint is Sky's own API (`http://127.0.0.1:8787/...`)
  is accepted.

## Round 2 (2026-10-02): Stars, all fixed

Bugs 9, 10 and 11 are now fixed, and their tests pass.

I tested the back-end branch (PR #1, `e577244`) merged with the UI branch
(`9f14cc1`) in Chromium and through the API. The server's 43 tests pass, and the
web app builds. All eight bugs from round 1 are fixed, and their tests now pass.

These work end to end: making a Star (including the error for a name that's
taken), chatting with a Star, handing work over from the main chat, one Star
asking another and carrying on with the answer, pausing one Star while the others
keep working, pausing and waking every Star, an approval landing in the chat of
the Star that asked for it, and removing a Star.

### 9. Text typed while an empty chat loads is wiped (medium, UI)

This explains the chat test timeouts the design thread couldn't reproduce.

While a chat's messages are loading, `Chat.tsx` shows the normal composer. If the
chat turns out to be empty, the page switches to the welcome view, which has its
own composer. That swap throws away anything typed in the first composer. Pressing
Enter then sends nothing, because the new box is empty. A test, or a quick user on
a fresh chat or a slow connection, types before the swap and loses the message.

The timeouts only show up when the main chat is empty, such as a fresh server
with no briefing posted yet, and when typing beats the messages response. That's
why the failures came and went. The test makes it repeatable: it slows the
messages response in an empty Star chat and types during the delay.

Fix idea: render the same `Composer` instance in both views, or lift its text
into `Chat`. Test: `qa/e2e/ui.test.mjs` "BUG 9". The other chat tests now wait for
the chat to load, so they test chat itself and not this race.

### 10. A removed Star's chat link loads forever (low, UI)

Opening `#/chat/<id>` for a removed Star's chat leaves the page on loading
placeholders. `Chat.tsx` calls `api.listMessages(activeId).then(setMessages)`
with no `catch`, so the 404 is dropped. The Star editor already handles this case
("That Star is gone"), and the chat could do the same. Test: "BUG 10".

### 11. Stopping a task doesn't stop the work it asked another Star for (low, server)

When a task is waiting on another Star (`ask_star`) and you stop it, the other
Star's task carries on and does the work for nobody. The same happens when the
asking Star is removed: the helper finishes and replies to a Star that no longer
exists. The reverse case works: if you stop the helper's task, the asking task
hears about it and ends. Fix idea: when a task ends, cancel the open `ask_star`
tasks it started. Test: `qa/server/contract.test.ts` "BUG 11".

Also seen, small enough to leave without tests:
- Constellation notes that involve a removed Star disappear from the feed
  (`StarNote` returns null when either Star is missing).
- Rules typed while making a new Star are dropped silently if saving one fails
  (`StarEditor.save` swallows the error).

## Round 1 (2026-10-02): all fixed

1. The app opened one event stream per hook, and 6 streams froze every request. Fixed.
2. Server errors were swallowed in chat, task commands and approvals. Fixed.
3. There was no way to sign in when a password was set. Fixed.
4. A reply cut off by a restart stayed "streaming" forever. Fixed.
5. Run now brought back a task you had stopped. Fixed.
6. A malformed URL returned a 500. Fixed.
7. A garbled activity cursor returned an empty page. Fixed.
8. PATCH /settings accepted a body that wasn't an object. Fixed.

## Not tested

- Real model providers and real websites. Outside sites are blocked here, so
  providers and pages were stand-ins on this machine.
- Push delivery to a real phone, through Web Push or ntfy.
- Real Claude. There's no API key here, so everything ran on the scripted brain.
  In particular, how well a real model picks `ask_star`, `hand_off` and
  `message_star` isn't tested.
- Real OAuth apps. Gmail was faked in-process.
- Approval expiry after 24 hours, and ask chains 3 deep through the UI. The
  server's own tests cover the depth limit.
