# How the Skys back end works

Skys is one person's always-on agent. The server in [`server/`](../server)
does two jobs: it serves the API in [API.md](API.md), and it keeps working
when nobody is looking.

```
 web app ──REST /api/v1──▶ http/routes ──▶ Store (SQLite) ──▶ EventBus ──SSE /events──▶ web app
                                 │              ▲
                                 ▼              │
                              Runtime ──────────┘
            clock · task queue · approvals · briefing · ideas · research
                 │                     │
            TaskRunner             ChatAgent
                 └──── Brain (Claude) + tools + Policy ────┘
                              │
                     Providers (Gmail, Calendar, Drive,
                     GitHub, Notion, Slack, Telegram, web)
```

## Pieces

| Piece | File | Job |
| --- | --- | --- |
| Store | `src/store.ts` | Every read and write. Saves, then emits the matching live event, so the database and the UI can't drift apart |
| Db | `src/db/db.ts` | One SQLite file. Records are JSON documents shaped by `web/src/api/types.ts`; steps, messages and activity are append-only tables. Tokens and pending tool calls sit in a private column the API never returns |
| HTTP | `src/http/` | Router, validation, error shape, CORS, SSE with a 25 s ping, sign-in, serving the built web app |
| Runtime | `src/agent/runtime.ts` | The always-on loop. A clock starts due tasks, expires approvals, writes the daily briefing at the person's time, offers new ideas and does proactive research when idle. Task runs go through one queue, so the orb shows one thing at a time; chat doesn't wait for the queue |
| TaskRunner | `src/agent/runner.ts` | Runs a task as a conversation with the model and its tools, recording every plan, thought, tool call and result as timeline steps |
| ChatAgent | `src/agent/chat.ts` | Streams replies. Chat only reads and organises; anything that acts on the world becomes a task, which is where approvals live |
| Policy | `src/agent/policy.ts` | Decides allow, ask or forbid for each action |
| Tools | `src/agent/tools/` | Core tools (remember, recall, progress, notify, finish, create and manage tasks) and app tools, each tagged with its effect |
| Providers | `src/connections/providers.ts` | OAuth, token refresh, and calling apps as the person. A 401 marks the connection expired and blocks the tasks that use it |
| Brain | `src/agent/brain.ts`, `scripted.ts` | Claude through the Anthropic SDK, or a scripted stand-in for tests and running without a key |

## A task's life

1. Created from the API, from chat (`create_task`), or from an idea. Recurring
   and watch tasks get their free-text schedule parsed ("Weekdays at 9:00",
   "every 3 hours, 7:00 to 22:00", "Mondays and Thursdays at 7pm") and a
   `nextRunAt` in the person's time zone. A step says how the schedule was read.
2. When due, the clock marks it `active` and queues it.
3. The runner starts a run: the brief, the previous outcome, recent steps,
   relevant memories and the current time. The system prompt carries the
   persona, tone, autonomy, rules, pinned memories and connections, and is
   cached.
4. Each model turn is saved before anything else happens, so a run survives
   restarts. Text becomes `plan`/`thought` steps; web searches become `tool`
   steps; tool calls become `tool`/`action`/`note` steps.
5. Before any tool call that changes something, the policy decides:
   - read-only connection: forbidden, and the model is told why
   - built-in rules: money always asks; passwords and security settings never happen
   - the person's own rules, checked by the model: allow, ask or forbid
   - autonomy: Ask first asks for every change; Balanced asks before sending,
     deleting and spending; Hands-off asks only before spending or deleting
6. "Ask" creates an approval (with the exact preview, risk and a 24-hour
   expiry), posts it as a card in the main chat, sets the task to
   `waiting_approval`, and the run stops there. Approve (optionally edited),
   decline or expiry is recorded; once every pending call in that turn is
   answered, the task is queued again and the runner carries out the decisions
   before the next model turn. A note on a decision is saved as memory.
7. `finish_task` ends the run. One-off tasks become `done` or `failed`;
   recurring and watch tasks go back to `scheduled` with the next run time.

Pausing Skys stops new runs and stops a running one at its next step; nothing
is lost. Pausing or stopping a single task works the same way.

## Reaching out

`notify_user`, approvals, and the daily briefing post a `proactive` message to
the main chat. Outside quiet hours (or when urgent) they also go to the
channels turned on in Settings: email to yourself through Gmail, Telegram, or
a Slack channel. Push needs a device subscription the UI doesn't collect yet.

## Ideas

Every few hours the runtime offers new ideas: starter ones that follow from
what's connected (tidy the inbox, a calendar heads-up, a weekly "what I
shipped"), and, with Claude, a few grounded in the person's goals, tasks and
recent activity. Each title is offered once; dismissing it keeps it gone.

## Safety

- Content from emails, pages and documents is treated as information, never instructions.
- Chat can't act on the world; only tasks can, and only through the policy.
- Built-in rules can't be edited or deleted (403).
- Tokens never leave the server.
- With `SKYS_PASSWORD` unset the server listens only on localhost.

## Model use

Requests go to the Messages API with adaptive thinking, an effort level
(`SKYS_EFFORT`, default `medium`), prompt caching on the system prompt,
Claude's server-side web search and fetch when the web connection is on, and
server-side refusal fallbacks. The conversation for a run is append-only, so
the cache and thinking blocks stay valid across turns and restarts.

## Additions to the API contract

These are server-side additions; nothing in the UI needs to change for them.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/health` | `{ ok, brain, model }`, no sign-in needed |
| GET | `/api/v1/session` | `{ signedIn, authRequired }` |
| POST | `/api/v1/session` | `{ password }`, sets the session cookie |
| DELETE | `/api/v1/session` | Signs out |
| GET | `/api/v1/oauth/callback` | Where OAuth providers return; redirects to `/#/connections` |
| GET | `/login` | Sign-in page when a password is set |

Behaviour worth knowing on the UI side:

- `POST /tasks/:id/run_now` returns `409` for one-off tasks or tasks already running; `resume` returns `409` unless the task is paused; `cancel` returns `409` once a task has finished.
- Resuming a recurring or watch task returns it to `scheduled`, not `active`.
- Deciding an approval that's no longer pending returns `409`.
- A recurring task without a schedule is a `400`; a watch task without one defaults to every 3 hours.
- Side chats start as "New chat" and take their title from the first message.
- `POST /connections/:id/connect` returns `400` with a message naming the missing server settings when a provider isn't configured.
