# Sky design

Sky is an always-on personal agent. You hand it something once and it keeps
working in the background, comes back when something is new or needs you, and
asks before anything it can't undo.

Naming: the app is **Sky**. Each agent in it is a **Star**, and Stars that work
together form a **constellation**. The first Star is the main one: it talks with
you first, passes work to the others, and can't be removed.

The look follows three references the user picked:

- **Grok**: quiet near-white and near-black surfaces, one centred task, pill
  controls, hairline borders, almost no shadow. Colour comes from the surface,
  not from a palette.
- **OpenAI Dots**: the agent is a character you name and dress, not a logo. Its
  profile shows what it's working on, what's upcoming and what's done.
- **Meta Muse**: one long main chat with bubbles, side chats for topics,
  proactive messages, a snippet under the avatar saying what it's doing, and
  structured approval cards inside the conversation.

## Principles

1. **Talk, don't operate.** The app opens on the main chat. Goals, approvals and
   findings arrive there as messages and cards. Other screens exist to look
   things up, not to run the day.
2. **The character is the only colour.** Everything else is monochrome, so the
   one living thing on screen is Sky. Warm orange is reserved for "needs you".
3. **Always say what it's doing.** The line under the character updates live
   and shimmers while it works.
4. **You stay in charge.** Approvals show the exact email or event, can be
   edited, and wait for a clear yes.

## Look

- Tokens are in `web/src/styles/tokens.css`. Light and dark follow the system,
  with a switch in Settings.
- Type is the device's own system face (SF Pro on Apple, Segoe UI Variable on
  Windows), with Geist loaded for everything else. Tight tracking on headings.
- Radii: 10 to 28px, pills for every control. Hairline borders, shadows only on
  the composer and overlays.

## The character

Three shapes (cloud, dot, drop) in five pastel colours, drawn as SVG in
`web/src/components/Avatar.tsx`.

| State | Behaviour |
| --- | --- |
| Idle | Floats gently, blinks every few seconds |
| Working | Breathes and its eyes read side to side |
| Needs you | Hops with a little squash and stretch |
| Paused | Eyes closed, colour drained, dozing |

On the empty chat, the profile and Settings, its eyes follow your pointer.
All motion stops under `prefers-reduced-motion`.

## Motion

One family of curves (`--spring`, `--sheet`). Messages rise in, the profile
sheet slides like an iOS sheet, toggles and buttons have a small press. No
decorative animation beyond the character.

## Screens

| Screen | What it's for |
| --- | --- |
| **Chat** | The main chat: bubbles, "reached out" messages, inline goal and approval cards, a capsule composer. An empty chat shows the character, one question and a few ideas |
| **A Star's chat** | Every Star has its own chat, listed under Stars in the sidebar. Its approval cards appear here, and so do the notes it trades with other Stars (asked, answered, handed work to, told), drawn as dashed cards between the bubbles |
| **Side chats** | Extra conversations for a topic with the current Star, listed in the sidebar |
| **Profile** (tap the character) | The current Star: name, role, live status, counts, Working on / Upcoming / Done, who it works with, edit, pause this Star or every Star |
| **Constellation** | A map of the Stars with lines where they've talked, a card per Star (role, independence, apps, pause), and the feed of notes between them |
| **New Star / edit a Star** | Start from a template (research, inbox, calendar, code), then name, character and colour, role and instructions, independence (or follow yours), which apps, and its own rules. Pause or remove from here |
| **Models** | The fallback order of model providers, any OpenAI-compatible or Anthropic-compatible one. Each row shows its health: working with latency, resting until a rate limit clears, needs fixing, or off. Drag or use the arrows to reorder, test, turn off, or edit. Adding one starts from a preset (Groq, OpenRouter, Ollama and so on). Keys are write-only: after saving, only "a key is saved, ending in 1234" shows, with Replace and Remove |
| **A Star's models** | On a Star's page: "Same as everyone" or "Its own order", picking and ordering the models that Star uses |
| **Live browser** | When a Star has a tab open, a small live thumbnail sits above the composer in its chat and in its profile. Opening it shows the page, live. "Take over" pauses that Star and lets you click, type, paste, scroll, go back or enter an address on the page, for example to sign in; "Hand back" wakes it again (unless it was already paused). Anything it wants to submit still comes as an approval card |
| **A Star's personality** | On a Star's page: its character and how it replies (with quick picks), plus two switches: ping me when it finishes something, and when it needs me |
| **Live status** | Each Star's current action ("Reading your inbox", "Writing") shows under its name in the sidebar, in the top bar and under the typing dots |
| **Skills** | Cards for each saved recipe: when to use it, who wrote it (you, a Star, or built in), how often it's used. Filter by Star; add, edit or remove in a sheet. Built-in ones are read-only |
| **Lessons** | When a Star learns from a correction, its chat shows a "Got it. I'll remember: …" card with Undo. Memory lists recent lessons with Undo and a switch to turn learning off |
| **Secrets** | In Permissions: a vault of names only. Adding or replacing takes a value in a password field; it is never shown again. Each secret can be limited to some Stars |
| **Notifications** | In Settings: push on this browser or phone, the list of devices, ntfy with a random topic, and a test. On iPhone a dismissible hint explains adding Sky to the Home Screen first |
| **Triggers** | A repeating goal can start when something happens: a webhook, a GitHub event, a Slack or Telegram message, or a Gmail search. Its page shows the URL and secret to paste (with copy, show and "make a new URL"), how often it has fired, and the events waiting to run (up to 20, 30 an hour). New goal offers "When something happens" |
| **Chat apps** | In Settings: connect a Telegram bot (token from @BotFather) or a Slack app (manifest from the server, then two tokens), pair by sending the 6-digit code, and see how to reach each Star there ("Scout: …" or "@Scout"). Messages that came from there say "via Telegram" |
| **A Star's address** | Its own Gmail plus-address, with copy, on its page and profile |
| **Tools** | MCP servers, local or hosted. Variables and headers are write-only and can come from the vault. Choose which Stars get each server and what each tool counts as (look only, changes, sends, deletes, spends), which decides when it asks |
| **Group chats** | In the sidebar. Pick two or more Stars; tap a face above the composer to @mention it. Each reply is labelled with the Star's name, and up to two reply per message |
| **Templates** | `#/stars/templates`: built-in and gallery templates, import from a file or link, the gallery source, and download any Star as a template (no memory, chats or secrets). "Share as template" is also on a Star's page |
| **Goals** | Everything the Stars have taken on, filterable by Star, with progress and schedule, plus a goal's step-by-step history and who asked for it |
| **Ideas** | Suggestions Sky came up with. "Do it" sends it to chat |
| **Approvals** | Everything waiting for a yes, and the history |
| **Memory** | What it knows about you; add, edit, pin, forget |
| **Permissions** | Independence level, apps with look-only or look-and-act access, rules, the safety guard, signing in with saved logins (off until confirmed), and secrets |
| **Safety guard** | How strict the second check is, and every action it stopped or asked about, with its reason |
| **Workspace** | Each Star's folder (browse, add, download, delete) and a read-only terminal of the commands it ran |
| **Voice** | The mic in a Star's chat opens a full-screen talk mode with the Star's character as its face; push to talk or hands-free. Settings has speech providers, and each Star can have its own voice |
| **Your computer** | Settings: pair with a one-time command, switch each computer on or off, see its allowlist (changed only on the computer), and choose which Stars can use it. Its approvals say plainly what it wants to open, read, write or run |
| **Checkout** | When a Star reaches payment it shows the total; "OK, I’ll pay" hands you the browser, and "I’ve paid, hand back" returns it |
| **Activity** | Everything it has done, by day |
| **Settings** | Name, character and colour, tone, briefing, quiet hours, channels, theme |

On phones the sidebar becomes a drawer and the profile becomes a bottom sheet.

## Running it

```
cd web
npm install
npm run dev          # runs on built-in sample data
VITE_SKYS_API_URL=http://localhost:8787 npm run dev   # against a real back end
```

The back-end contract is in [API.md](API.md).

## Characters

Seven characters: star, sparkle, nova and comet (the Stars), then cloud, dot and drop. Each has a soft grain, a rim of light, a glint and a small smile that changes with its state (working, needs you, paused). They float and sway out of step with each other, glance about when idle, and the big ones twinkle and squash when poked. Grain and rim only draw from 34px up, so the small ones stay crisp.
