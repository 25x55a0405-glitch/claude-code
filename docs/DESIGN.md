# Skys design

Skys is an always-on personal agent. You hand it something once and it keeps
working in the background, comes back when something is new or needs you, and
asks before anything it can't undo.

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
   one living thing on screen is Skys. Warm orange is reserved for "needs you".
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
| **Side chats** | Extra conversations for a topic, listed in the sidebar |
| **Profile** (tap the character) | Name, handle, live status, counts, Working on / Upcoming / Done, links to the rest, pause |
| **Goals** | Everything Skys has taken on, with progress and schedule, plus a goal's step-by-step history |
| **Ideas** | Suggestions Skys came up with. "Do it" sends it to chat |
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
