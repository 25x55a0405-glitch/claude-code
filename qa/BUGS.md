# Sky bugs found in testing

Each bug has a test named "BUG n" that fails until it's fixed. The testing
thread reports these, and the UI and back-end threads own the fixes.

## Round 2 (2026-10-02): Stars

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

- Real Claude. There's no API key here, so everything ran on the scripted brain.
  In particular, how well a real model picks `ask_star`, `hand_off` and
  `message_star` isn't tested.
- Real OAuth apps. Gmail was faked in-process.
- Approval expiry after 24 hours, and ask chains 3 deep through the UI. The
  server's own tests cover the depth limit.
