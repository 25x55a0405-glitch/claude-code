# Sky API contract (v1)

This is what the Sky web UI expects from the back end. The source of truth for
every shape is [`web/src/api/types.ts`](../web/src/api/types.ts); the client
that calls these endpoints is [`web/src/api/http.ts`](../web/src/api/http.ts).
[`web/src/api/mock.ts`](../web/src/api/mock.ts) is a working in-memory
reference implementation of the same behaviour, including live events, and is
the quickest way to see what each call should do.

## Conventions

- Base path: `/api/v1`. The UI is pointed at a server with
  `VITE_SKYS_API_URL` (e.g. `http://localhost:8787`, or `""` for same origin).
  Without it, the UI runs on the mock.
- JSON in and out, `Content-Type: application/json`.
- Auth: a session cookie. The UI sends `credentials: 'include'` on every
  request and `withCredentials` on the event stream. A single-user setup is
  fine for v1; return `401` with the error body below when not signed in.
- Timestamps are ISO 8601 UTC strings. Ids are opaque strings.
- `DELETE` and other calls with nothing to return reply `204 No Content`.
- Errors: any non-2xx status with
  `{ "error": { "code": "not_found", "message": "Task t_1 not found" } }`.
  The UI shows `message` to the user, so keep it human-readable.
- `PATCH` bodies are partial: only the fields sent change.

## Agent status

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/status` | | `AgentStatus` |
| POST | `/status` | `{ "paused": boolean }` | `AgentStatus` |

`AgentStatus.state` drives the orb everywhere in the UI:

- `working` when Sky is actively running a step (`activity` says what, `taskId` links to it)
- `waiting` when nothing is running and at least one approval is pending
- `idle` when nothing is running and nothing is pending
- `paused` when the user paused Sky; no background work or actions may run
- `offline` when the agent runtime is unreachable

`counts.activeTasks` counts tasks in `active`, `waiting_approval` or `blocked`.

## Briefing

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/briefing` | `Briefing` (latest one) |

Generated at `Settings.briefingTime` in the user's time zone. A highlight
links to a task (`taskId`) or an approval (`approvalId`) when relevant.

## Tasks

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/tasks?status=active,blocked` | | `Task[]`, newest `updatedAt` first |
| GET | `/tasks/:id` | | `TaskDetail` (task plus `steps`, oldest first) |
| POST | `/tasks` | `CreateTaskInput` | `Task` |
| POST | `/tasks/:id/pause` | | `Task` |
| POST | `/tasks/:id/resume` | | `Task` |
| POST | `/tasks/:id/run_now` | | `Task` (recurring and watch tasks only) |
| POST | `/tasks/:id/cancel` | | `Task` (status becomes `done`) |

`status` filter is a comma-separated list of `TaskStatus`; omitted means all.
`schedule` is free text from the user ("Weekdays at 9:00"). The back end owns
turning it into a real schedule and fills `nextRunAt`. Each command should
also append a `note` step ("Paused by you") so the timeline explains itself.

Step kinds and how the UI shows them: `plan` and `note` neutral, `thought`
violet, `action` and `tool` sky, `result` green, `approval` orange, `error`
red. `detail` is optional raw output shown behind a "Details" toggle.

## Approvals

Anything that sends, spends, deletes or can't be undone becomes an approval
unless the user's autonomy level and rules allow it. Built-in rules (money,
passwords) always produce an approval.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/approvals?status=pending` | | `Approval[]`, newest first; no `status` means all |
| POST | `/approvals/:id/decision` | `ApprovalDecision` | `Approval` |

`ApprovalDecision.editedPreview` means "do it, but with my edits".
`note` is feedback the agent should store as memory. An approval past
`expiresAt` becomes `expired` and the task skips that action.

## Conversations

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/conversations` | | `Conversation[]`, newest `updatedAt` first, always including the main chat |
| POST | `/conversations` | `{}` | `Conversation` |
| GET | `/conversations/:id/messages` | | `Message[]`, oldest first |
| POST | `/conversations/:id/messages` | `{ "content": string }` | the stored user `Message` |

Every user has exactly one conversation with `main: true`. It is the one long
chat the app opens to, and where proactive messages go. Others are side chats
the user starts for a topic; title them from their first message.

The agent's reply is not in the POST response. It streams over the event
stream: one or more `message.delta` events with the same `messageId`, then a
`message.done` with the final `Message`.

`Message.cards` puts structured cards under a message: `{ kind: "task", taskId }`
shows a live goal card and `{ kind: "approval", approvalId }` shows an approval
the user can answer right in chat. When Sky needs an approval, post a main-chat
message with the approval card as well as creating the approval.

Set `proactive: true` on messages Sky sends on its own (briefings, findings,
requests for a decision). The UI labels them "Sky reached out". Keep the bar
high: only send one when something is new or needs the user.

## Memory

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/memory` | | `MemoryItem[]` |
| POST | `/memory` | `{ category, content }` | `MemoryItem` (`source` "Added by you") |
| PATCH | `/memory/:id` | `{ content?, pinned?, category? }` | `MemoryItem` |
| DELETE | `/memory/:id` | | `204` |

Deleting must actually remove it from what the agent uses. Pinned items
should always be in the agent's context.

## Connections

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/connections` | | `Connection[]`, including ones not yet connected |
| PATCH | `/connections/:id` | `{ access: "read" \| "read_write" }` | `Connection` |
| POST | `/connections/:id/connect` | | `{ authorizeUrl: string \| null, connection }` |
| POST | `/connections/:id/disconnect` | | `Connection` |

For OAuth providers, `connect` returns `authorizeUrl`; the UI redirects there
and the provider should redirect back to `/#/connections`. When a token stops
working, set `status: "expired"`, move dependent tasks to `blocked`, and emit
`task.updated`. `read` access must stop the agent from writing through that
connection.

The UI has logos for these `provider` keys: `gmail`, `calendar`, `github`,
`web`, `notion`, `slack`, `drive`, `telegram`. Others get a generic tile.

## Rules

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/rules` | | `Rule[]` |
| POST | `/rules` | `{ text }` | `Rule` |
| PATCH | `/rules/:id` | `{ text?, enabled? }` | `Rule` |
| DELETE | `/rules/:id` | | `204` |

Rules are plain language and are given to the agent as hard constraints.
`builtIn` rules can't be changed or deleted (return `403`).

## Ideas

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/ideas` | `Idea[]`, newest first |
| POST | `/ideas/:id/dismiss` | `204` |

Ideas are things Sky could do, generated from the user's goals and patterns.
"Do it" in the UI sends `Idea.prompt` to the main chat and then dismisses the
idea. Emit `idea.created` when a new one appears.

## Activity

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/activity?cursor=…` | `Page<ActivityEvent>`, newest first |

An append-only log of everything the agent did, including proactive research.

## Settings

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/settings` | | `Settings` |
| PATCH | `/settings` | partial `Settings` | `Settings` |

`avatar` is the user's choice of character (`cloud`, `dot`, `drop`) and colour
(`sky`, `peach`, `mint`, `lilac`, `sun`); the UI draws it. `autonomy` lives
here too and is echoed in `AgentStatus.autonomy`. Every change emits
`settings.updated`, and an autonomy change also emits `status`. Nested objects (`quietHours`, `channels`) are
sent whole.

## Stars

The UI's Star screens use the endpoints and events in
[BACKEND.md](BACKEND.md#stars-and-the-constellation-for-the-ui-to-build-on)
(`/stars`, `/stars/:id/pause`, `/constellation/messages`, `star.updated`,
`star.deleted`, `constellation.message`) and the optional `starId` fields and
filters listed there. The shapes are `Star`, `StarView` and
`ConstellationMessage` in `web/src/api/types.ts`. A server without `/stars`
still works: the UI shows a single Star built from Settings.

## Live events

`GET /events` is a Server-Sent Events stream. Each event uses the SSE `event:`
field for the type and a JSON `data:` line for the payload:

```
event: task.step
data: {"taskId":"t_inbox","step":{"id":"s7","at":"2026-10-02T09:40:00Z","kind":"result","summary":"Archived 2 notifications"}}
```

| Event | Data | Send when |
| --- | --- | --- |
| `status` | `AgentStatus` | state, activity or counts change |
| `task.updated` | `Task` | any task field changes, or a task is created |
| `task.step` | `{ taskId, step }` | a step is appended |
| `approval.created` | `Approval` | a new approval is needed |
| `approval.updated` | `Approval` | an approval is decided or expires |
| `message.delta` | `{ conversationId, messageId, delta }` | agent reply text streams |
| `message.done` | `Message` | agent reply finishes |
| `activity` | `ActivityEvent` | an activity entry is appended |
| `memory.learned` | `MemoryItem` | the agent saves a new memory on its own |
| `idea.created` | `Idea` | a new idea is ready |
| `settings.updated` | `Settings` | settings change, from any device |

Send a comment line (`: ping`) every 25 seconds so proxies keep the stream
open. The browser reconnects on its own; the UI refetches what it shows when
events arrive, so missed events are not fatal.

## Not in the UI yet

Push notifications, Slack and Telegram delivery, and voice are settings-only
in the UI today (`Settings.channels`). The back end can deliver on those
channels without UI changes.
