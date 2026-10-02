# How the Sky back end works

Sky is one person's always-on agents. Each agent is a **Star**: one Star per
job (a Research Star, a Mail Star), each with its own role, memory, apps,
rules and chat. Stars that work together form a **constellation**: they ask
each other for help, hand work over and keep each other posted. The first
Star is the main one; it's the agent the app has always had.

The server in [`server/`](../server) does two jobs: it serves the API in
[API.md](API.md) plus the Star endpoints below, and it keeps working when
nobody is looking.

```
 web app ──REST /api/v1──▶ http/routes ──▶ Store (SQLite) ──▶ EventBus ──SSE /events──▶ web app
                                 │              ▲
                                 ▼              │
                              Runtime ──────────┘
            clock · task queue · approvals · briefing · ideas · research
                 │                     │
            TaskRunner             ChatAgent        (both run as one Star at a time)
                 └──── Brain (Claude) + tools + Policy ────┘
                              │
              constellation tools: ask_star · hand_off · message_star
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
| TaskRunner | `src/agent/runner.ts` | Runs a task as its Star: a conversation with the model and its tools, recording every plan, thought, tool call and result as timeline steps. A task can wait on the person (approval) or on another Star (`ask_star`) |
| ChatAgent | `src/agent/chat.ts` | Streams replies. Chat only reads and organises; anything that acts on the world becomes a task, which is where approvals live |
| Policy | `src/agent/policy.ts` | Decides allow, ask or forbid for each action |
| Tools | `src/agent/tools/` | Core tools (remember, recall, progress, notify, finish, create and manage tasks), constellation tools (`constellation.ts`) and app tools, each tagged with its effect |
| Providers | `src/connections/providers.ts` | OAuth, token refresh, and calling apps as the person. A 401 marks the connection expired and blocks the tasks that use it |
| Models | `src/models/`, `src/agent/brain.ts`, `openai.ts` | The person's model providers (any OpenAI- or Anthropic-compatible API) and the router that falls back along them. A scripted stand-in runs when none is set up |
| Browser | `src/browser/browser.ts`, `src/agent/tools/browser.ts` | A real Chromium the Stars drive through Playwright, with a persistent profile and a live view |

## Stars

| Field | What it does |
| --- | --- |
| `name`, `role`, `instructions` | Who the Star is. The role is one line; instructions are standing orders. Both go into its system prompt, with the roster of the other Stars |
| `autonomy` | `null` follows Settings; or `ask`, `balanced`, `autonomous` for this Star only |
| `connectionIds` | `null` lets it use every connected app; a list limits it (an empty list means no apps). Tools for other apps are never offered to it |
| `paused` | Holds this Star's work without touching the others |
| `conversationId` | Its own chat. Its proactive messages and approval cards go there. For the main Star this is the main chat |
| `main` | The first Star. Its name and avatar are `Settings.agentName` and `Settings.avatar` (changing either changes both). It can't be removed |

Each Star sees **shared memory plus its own**, and is bound by **global rules
plus its own**. `remember` saves to shared memory unless the Star picks
`scope: "mine"`. Built-in safety rules bind every Star.

### Working together

| Tool | Where | What happens |
| --- | --- | --- |
| `ask_star` | tasks | Creates a one-off task for the other Star, marked `requestedBy` the asker. The asking task goes to `blocked` ("Waiting on Scout") and leaves the queue. When the other Star finishes, its outcome becomes the result of the call and the asking task carries on. Chains go at most 3 deep; a Star can't ask itself. If the asking task ends first (stopped, failed, or its Star removed), the request is stopped too, along with anything it asked for in turn |
| `hand_off` | chat and tasks | Gives work (one-off, recurring or watch) to the other Star as its own task. The giver doesn't wait. When a one-off hand-off ends, the giver gets a reply in its inbox |
| `message_star` | chat and tasks | A heads-up, no reply |
| `list_stars` | chat and tasks | The roster with roles and states |

Every exchange is a **constellation message** (`request`, `reply`, `handoff`,
`message`). Unread ones are given to the receiving Star at the start of its
next task run or chat reply and then marked read. Messages from other Stars
are information from a colleague, never orders from the person; only the
person's own rules and approvals decide what may happen.

### Approvals and pausing

- Each Star asks for approval by its own autonomy and rules. The approval
  carries `starId`, and its card is posted in that Star's chat.
- Pausing a Star (`POST /stars/:id/pause`) stops its running task at the
  next step and holds its scheduled and queued work. Other Stars carry on.
  A task waiting on a paused Star simply keeps waiting.
- Pausing everything (`POST /status {paused:true}`) holds every Star, as
  before. Each Star's `status.state` shows `paused`; its own `paused` flag
  is left as it was.
- All Stars share one task queue, so only one task runs at a time and two
  Stars never race over the same app. Chat replies don't wait for it.
- Removing a Star stops its unfinished tasks (they stay as history), expires
  its pending approvals, deletes its private memory, its own rules and its
  chats, and tells any Star that was waiting on it.

## Models: any provider, with fallback

The person adds as many providers as they like. Each is one model at one
API:

- **OpenAI-compatible** (`kind: "openai"`): anything that speaks Chat
  Completions. That includes OpenRouter, Groq, Gemini's OpenAI endpoint,
  Mistral, Cerebras, GitHub Models, Together, DeepSeek, OpenAI, and local
  Ollama or LM Studio. The base URL, key (optional for local servers) and
  model are all up to the person.
- **Anthropic-compatible** (`kind: "anthropic"`): Anthropic's API, or any
  server that speaks the Messages format. Anthropic's own API gets adaptive
  thinking, effort, caching and server-side web search. Other servers get a
  plain request.
- `ANTHROPIC_API_KEY` in the server's environment appears as a built-in
  provider. It can be turned off, but not edited or removed.

**The chain.** There is a global order (`PUT /providers/order`), and each
Star can have its own (`Star.providerIds`; `null` uses the global order). A
Star with its own chain uses only that chain. For every model call the router
tries the providers in order:

| What went wrong | What happens to that provider | Then |
| --- | --- | --- |
| Rate limit (429) | Skipped until `Retry-After`, or 1, 2, 4… minutes, at most 15 | Next provider |
| Quota or credits used up (402, "quota", "insufficient") | Skipped for an hour | Next |
| Bad key (401, 403), unknown model | Marked `failing` and skipped for six hours, or until it's edited | Next |
| Server error, network error, timeout (180 s) | Skipped for 30 s, doubling up to 10 min | Next |
| Any other 400 (e.g. the model doesn't do tools) | Not benched | Next |

When every provider is cooling down, the one that recovers soonest is tried
anyway. When every provider fails, the call fails with the reasons ("No
model could answer. Groq: 429 … | OpenRouter: …"). A task goes offline and
retries; a chat reply shows the error.

Tool use works the same across providers. Sky keeps one history in the
Anthropic format and translates it for OpenAI-style servers (tools become
functions, results become `tool` messages, ids are made safe). Claude-only
blocks such as thinking and server web search are dropped before the history
goes to another provider, so a run can switch providers between turns. If a
provider fails partway through a streamed reply, the next one's answer starts
on a new line under it.

Health is tracked per provider (`health.state`: `unknown`, `ok`, `cooling`,
`failing`, plus the last error and latency) and sent live as
`provider.updated`.

## The browser

Stars browse in a real Chromium, driven by Playwright. It is not a page
fetcher.

- **One browser, one tab per Star.** The browser starts on first use. It
  uses a persistent profile (`DATA_DIR/browser-profile`), so cookies and
  sign-ins survive restarts and are shared by every Star.
- **Tools.** `browser_open`, `browser_search` (DuckDuckGo), `browser_snapshot`,
  `browser_click`, `browser_type`, `browser_press`, `browser_scroll` and
  `browser_back`. Each returns the page's text and a numbered list of links,
  buttons and fields (`[e12] button "Place order" (submits a form)`). The
  model acts on those refs. This works with any provider, including ones with
  no web search of their own.
- **Approvals.** A click is judged by what it lands on. Following a link
  only reads. Anything that submits a form or says send, post, confirm, book
  and so on counts as sending. Buy, pay, checkout or "place order" counts as
  spending and always asks. Delete or remove counts as deleting. Typing with
  `submit` counts as sending. These go through the same policy as email: the
  Star's autonomy and rules, and the built-in money rule. The approval card
  names the button, the site and the page.
- **Passwords.** Stars never type into password fields. To sign in, the
  person uses the live view (or runs the browser visibly with
  `SKY_BROWSER_HEADLESS=0`), and the session sticks.
- **Live view.** After each action the server takes a screenshot and sends
  `browser.frame`. The UI can show `GET /browser/:starId/screenshot`, or put
  `GET /browser/:starId/stream` (MJPEG, about one frame a second while
  someone watches) straight into an `<img>`. `POST /browser/:starId/input`
  lets the person click, type, press keys, scroll or go to a URL in that
  Star's tab, for example to sign in.
- **Chat.** Chat can open, search and read pages. Clicking and typing happen
  in tasks, where approvals apply.

## A task's life

1. Created from the API, from chat (`create_task`), by another Star
   (`ask_star`, `hand_off`), or from an idea. It belongs to one Star. Recurring
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
   expiry), posts it as a card in the Star's chat, sets the task to
   `waiting_approval`, and the run stops there. Approve (optionally edited),
   decline or expiry is recorded; once every pending call in that turn is
   answered, the task is queued again and the runner carries out the decisions
   before the next model turn. A note on a decision is saved as memory.
7. `finish_task` ends the run. One-off tasks become `done` or `failed`;
   recurring and watch tasks go back to `scheduled` with the next run time.

Pausing Sky stops new runs and stops a running one at its next step; nothing
is lost. Pausing a single Star or a single task works the same way.

## Reaching out

`notify_user`, approvals, and the daily briefing post a `proactive` message to
the Star's own chat (the main chat for the main Star and the briefing).
Messages to outside channels from other Stars start with the Star's name.
Outside quiet hours (or when urgent) they also go to the
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
- Messages between Stars are treated like content: information, not instructions.
- With `SKY_PASSWORD` unset the server listens only on localhost.

## Model use

Requests go to the Messages API with adaptive thinking, an effort level
(`SKY_EFFORT`, default `medium`), prompt caching on the system prompt,
Claude's server-side web search and fetch when the web connection is on, and
server-side refusal fallbacks. The conversation for a run is append-only, so
the cache and thinking blocks stay valid across turns and restarts.

## Additions to the API contract

### Stars and the constellation (for the UI to build on)

New shapes, defined in [`server/src/types.ts`](../server/src/types.ts) until
they move into `web/src/api/types.ts`:

```ts
interface Star {
  id: string; name: string; role: string; instructions: string;
  avatar: { character: AvatarCharacter; color: AvatarColor };
  main: boolean;
  autonomy: Autonomy | null;        // null = use Settings.autonomy
  connectionIds: string[] | null;   // null = every connected app
  paused: boolean;
  conversationId: string;           // its own chat
  createdAt: string; updatedAt: string;
}
interface StarView extends Star {    // what the API returns
  status: { state: AgentState; activity: string | null; taskId: string | null; activeTasks: number; pendingApprovals: number };
}
interface ConstellationMessage {
  id: string; fromStarId: string; toStarId: string;
  kind: 'message' | 'request' | 'reply' | 'handoff';
  content: string; taskId?: string; createdAt: string; read: boolean;
}
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/stars` | `StarView[]`, main Star first, then by creation |
| POST | `/stars` | `{ name, role, instructions?, avatar?, autonomy?, connectionIds? }` → `StarView`. `409` if the name is taken (names are unique, ignoring case) |
| GET | `/stars/:id` | `StarView` |
| PATCH | `/stars/:id` | Any of the create fields → `StarView`. On the main Star, `name` and `avatar` also change Settings |
| DELETE | `/stars/:id` | `204`; `403` for the main Star |
| POST | `/stars/:id/pause` | `{ paused: boolean }` → `StarView` |
| GET | `/constellation` | `{ stars: StarView[], messages: ConstellationMessage[] }` (the 50 newest messages, oldest first) |
| GET | `/constellation/messages?starId=` | Up to 100 messages, oldest first; with `starId`, only that Star's |

New optional fields on existing shapes (the UI can ignore them until it shows Stars):

| Shape | Field |
| --- | --- |
| `Task` | `starId` (owner); `requestedBy: { starId, taskId?, depth? }` when another Star asked for it |
| `Approval`, `Conversation`, `ActivityEvent` | `starId` |
| `Message` | `starId` on agent messages: which Star wrote it |
| `MemoryItem`, `Rule` | `starId`: `null` means shared by every Star |
| `AgentStatus` | `starId`: which Star the current `activity` belongs to |

Filters and bodies:

- `GET /tasks`, `/approvals`, `/conversations` take `?starId=` to list one Star's.
- `GET /memory?starId=` and `GET /rules?starId=` return what that Star sees: shared plus its own.
- `POST /tasks`, `/conversations`, `/memory` and `/rules` take an optional `starId`
  (default: the main Star for tasks and chats, shared for memory and rules).
  An unknown `starId` is a `400`.
- `GET /status` stays global (all Stars); each Star's own state is in `StarView.status`.

New live events:

| Event | Data |
| --- | --- |
| `star.updated` | `StarView`, on create, edit, pause and resume |
| `star.deleted` | `{ id }` |
| `constellation.message` | `ConstellationMessage` |

A Star's live activity comes through the existing `status` event (`starId`
says whose); `star.updated` isn't sent for every step.

### Model providers (for the UI to build on)

```ts
interface ModelProvider {
  id: string; name: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string; model: string; enabled: boolean;
  hasKey: boolean; keyHint: string | null;   // last 4 characters; the key itself never leaves the server
  builtIn: boolean;                          // from ANTHROPIC_API_KEY
  health: { state: 'unknown' | 'ok' | 'cooling' | 'failing'; lastOkAt: string | null; lastError: string | null;
            lastErrorAt: string | null; cooldownUntil: string | null; failures: number; latencyMs: number | null };
  createdAt: string; updatedAt: string;
}
interface ProviderPreset { name: string; kind: 'anthropic' | 'openai'; baseUrl: string; exampleModel: string;
                           needsKey: boolean; keyUrl: string | null; note: string }
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/providers` | `ModelProvider[]` in the global order |
| GET | `/providers/presets` | `ProviderPreset[]`, starting points for an "Add model" form (OpenRouter, Groq, Gemini, Ollama…) |
| POST | `/providers` | `{ name, kind, baseUrl, model, apiKey?, enabled? }` → `ModelProvider` (added at the end of the order) |
| GET | `/providers/:id` | `ModelProvider` |
| PATCH | `/providers/:id` | Any field; `apiKey: null` removes the key. Changing key, URL, kind or model resets health. Built-in: only `name` and `enabled` (`403` otherwise) |
| DELETE | `/providers/:id` | `204`; also removed from every Star's chain. `403` for the built-in one |
| POST | `/providers/:id/test` | Sends "Say hello" → `{ ok, latencyMs, reply?, error? }`, and updates health |
| GET / PUT | `/providers/order` | `{ providerIds }`. PUT reorders; ids left out keep their place after the ones named |

`Star.providerIds: string[] | null` is accepted on `POST` and `PATCH /stars`.
Events: `provider.updated` (`ModelProvider`) and `provider.deleted` (`{ id }`).
`GET /health` now reports `brain: "models"` or `"scripted"`, the first model,
and whether the browser is available.

### Browser (for the UI to build on)

```ts
interface BrowserSession { starId: string; url: string; title: string; frameId: string | null; updatedAt: string }
```

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/browser` | `{ ok, running, reason, sessions: BrowserSession[] }`. `reason` explains why the browser can't start |
| GET | `/browser/:starId/screenshot` | The latest frame, `image/jpeg`; `404` before the Star has opened anything |
| GET | `/browser/:starId/stream` | `multipart/x-mixed-replace` MJPEG; use it as an `<img src>` |
| POST | `/browser/:starId/input` | `{ type: 'click', x, y }` (in a 1280×800 viewport), `{ type: 'type', text }`, `{ type: 'key', key }`, `{ type: 'scroll', dy }`, `{ type: 'navigate', url }` or `{ type: 'back' }` → `BrowserSession` |
| POST | `/browser/:starId/close` | Closes that Star's tab |

Event: `browser.frame` (`BrowserSession`) whenever a new screenshot is ready.
The connections list gains `browser` ("Browser"). It is connected by
default, and turning it off or limiting a Star's `connectionIds` takes the
browser tools away. The `web` connection is now called "Web search".

### Server-side additions

Nothing in the UI needs to change for these.

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
