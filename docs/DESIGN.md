# Skys design

Skys is an always-on personal agent. You hand it something once and it keeps
working in the background: running tasks, watching for changes, researching on
its own, and checking with you before anything risky. The design takes its
cues from OpenAI's Dots (ongoing responsibility, approvals, learning your
preferences), with GrokBot's conversational edge and Muse AI's personality.

## Principles

1. **Always visible, never noisy.** The orb shows what Skys is doing on every
   screen. Detail is one click away, never pushed at you.
2. **You stay in charge.** Anything that sends, spends or can't be undone
   waits for your OK, with the exact content shown and editable.
3. **Show the work.** Every task has a timeline of what Skys planned, thought,
   did and found, so trust is earned, not assumed.
4. **It's yours.** Memory, rules and connections are plain, editable lists.
   Delete something and Skys forgets it.

## The look: night sky and day sky

- Dark "night sky" is the default; light "day sky" follows the system or a
  setting. Tokens live in `web/src/styles/tokens.css`.
- Accent is a sky-blue to violet gradient. Warm "dawn" orange means *needs
  you*; green means done; amber means blocked; red is reserved for errors and
  declines.
- Type: Space Grotesk for headings, Inter for everything else.
- Soft, large radii (12 to 26px), quiet borders, faint glows instead of heavy
  shadows.

## The orb

The orb is Skys' face and the one signature element.

| State | Look |
| --- | --- |
| Idle | Sky and violet, slow breathing |
| Working | Spinning sheen and an outward ripple |
| Needs you | Turns dawn orange, faster pulse |
| Paused / offline | Desaturated and still |

It respects `prefers-reduced-motion`.

## Screens

| Screen | Purpose |
| --- | --- |
| **Home** | Greeting and briefing, what Skys is doing now, a quick-ask box, counts, the top approval, and active tasks |
| **Chat** | Conversations with streaming replies; replies that start work link to the task |
| **Tasks** | Everything Skys is responsible for: one-off, recurring, and watching. Filter by in progress, scheduled, finished |
| **Task detail** | Status, schedule, progress, pending approvals for this task, and the step timeline. Pause, resume, run now, stop |
| **Approvals** | Waiting actions with reason, risk, exact preview, edit-before-approve, and a note Skys remembers. History tab |
| **Memory** | What Skys knows about you by category; add, edit, pin, forget |
| **Connections** | Apps Skys can use, with read-only vs read-and-act per app; connect, reconnect, disconnect |
| **Rules** | Autonomy level (Ask first, Balanced, Hands-off) and plain-language rules. Built-in safety rules can't be turned off |
| **Activity** | The full log, grouped by day |
| **Settings** | Pause everything, name and tone, appearance, briefing time, quiet hours, proactive research, channels |

Desktop uses a sidebar; phones get a bottom tab bar with Home, Chat, Tasks,
Approvals and Settings, and the rest are reached from Settings.

## Running it

```
cd web
npm install
npm run dev          # runs on the built-in mock with sample data
VITE_SKYS_API_URL=http://localhost:8787 npm run dev   # against a real back end
```

The back end contract is in [API.md](API.md).
