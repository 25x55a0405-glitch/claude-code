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
| **Goals** | Everything the Stars have taken on, filterable by Star, with progress and schedule, plus a goal's step-by-step history and who asked for it |
| **Ideas** | Suggestions Sky came up with. "Do it" sends it to chat |
| **Approvals** | Everything waiting for a yes, and the history |
| **Memory** | What it knows about you; add, edit, pin, forget |
| **Permissions** | Independence level, apps with look-only or look-and-act access, and rules |
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
