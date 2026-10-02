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
channels turned on in Settings: email to yourself through Gmail, Telegram, a
Slack channel, and push to your devices (Web Push and ntfy, below). Push also
tells you when a one-off task you gave a Star finishes, if that Star's
`notify.whenDone` is on, and skips a Star's "can I…?" questions when its
`notify.whenNeedsYou` is off.

## Wave 1: personality, live status, skills, learning, secrets, push

- **Personality.** Each Star has `personality` (its character) and
  `replyStyle` (how replies look). Both go into its system prompt. A Star can
  change its own with `set_personality` when the person asks in chat.
- **Live status.** `star.activity` events carry a short phrase per Star
  ("Thinking", "Writing", "Reading your inbox", "Browsing"…) while it chats or
  works, and `null` when it stops. `StarView.status.activity` has the same.
- **Skills.** Saved recipes: a name, when to use it, and steps. The prompt
  lists each skill's name and when-to-use; a Star calls `use_skill` to read
  the steps, `save_skill` when it works out something worth repeating, and
  `update_skill` to improve one. The person can add, edit and delete them.
  "Forget something" is built in (recall with ids, then `forget_memories`).
- **Learning from corrections.** A declined approval, an approval with an
  edited preview, a task the Star itself reports as failed, or a chat
  message starting "no…/actually…/don't…" makes the Star ask a model (the
  `smallProviderIds` chain if set, else its own) for one general lesson. It
  becomes a shared memory, or a "- Lesson: …" line on the skill it's about,
  and the Star says "Got it. I'll remember: …" in its chat with a `lessonId`
  the UI can offer to undo. Nothing is saved when there's no general lesson.
  With `learnFromCorrections: false`, an approval note is saved as written,
  like before.
- **Secrets.** The person stores values (API keys, codes) under a name. They
  are encrypted with AES-256-GCM using `SKY_SECRET_KEY`, or a key file made
  at `DATA_DIR/secret.key` (back it up, or the secrets can't be read). Stars
  see only names and write `{{secret:NAME}}`; the value goes in just before
  the tool runs, any value that comes back is replaced with `[secret:NAME]`,
  and using a secret always asks first (high risk), whatever the autonomy.
  Secrets only reach a task's tools that act outside Sky: chat, memory,
  skills and Star-to-Star messages get an error instead. A secret can be
  limited to some Stars (`starIds`).
- **Push.** Web Push with the server's own VAPID keys (made on first use, kept
  in the database), and ntfy (ntfy.sh or self-hosted) as a second free
  channel: install the ntfy app and subscribe to the topic.

Free-tier notes:

- Web Push costs nothing and needs no account: browsers deliver it through
  their own push services. On iPhone it works only once Sky is added to the
  home screen (iOS 16.4 or later), so the UI needs a web app manifest and a
  service worker.
- ntfy.sh is free with no account; anyone who knows the topic can read it,
  so the topic should be long and random. A self-hosted ntfy server is
  supported through `ntfyServer`.
- From the sandbox this was built in, outside hosts are blocked, so a real
  delivery to Google, Mozilla or Apple push services and to ntfy.sh couldn't
  be checked. The tests check the encrypted, VAPID-signed request web-push
  builds for a real device key, and the ntfy request.

## Wave 2: events, messaging apps, Star email, MCP, group chats, templates

- **Event triggers.** A recurring task can have a `trigger` instead of (or as
  well as) a schedule. It can be a webhook, a GitHub webhook, a Slack or
  Telegram message, or an email.
  - **How it runs.** Each event is queued for the task (at most 20 waiting,
    30 an hour) and handed to the Star at the start of a run inside
    `<event>…</event>`, marked as content to work with, not instructions.
    Events that arrive mid-run get their own run afterwards.
  - **Webhooks** arrive at `POST /api/v1/hooks/<token>`, which needs no
    sign-in: the token is the secret. Rotating it retires the old URL.
  - **GitHub** deliveries must carry a valid `X-Hub-Signature-256` for the
    task's secret. They can be limited to some events, and `ping` is
    answered.
  - **Email** triggers are a Gmail search, polled every `mailPollMinutes`
    (default 3). Gmail's instant push needs Google Pub/Sub, which isn't
    free. Mail already there when the trigger is made doesn't count.
  - **Stars can set triggers too.** `create_task` takes a `trigger`, so a
    Star can set up "when an email from my bank arrives…" from chat.
- **Two-way Telegram and Slack.** Neither needs a public URL: Telegram uses
  long polling and Slack uses Socket Mode.
  - **Pairing.** The person connects a bot in the app, then sends the bot
    the 6-digit pairing code. Telegram also gets a `t.me` link with the
    code filled in. After that only that Telegram chat, or that Slack user,
    reaches the Stars; everyone else is ignored.
    - The message must be exactly the code (or `pair <code>`, or the
      link's `/start <code>`); a message holding a list of codes is a wrong
      try.
    - The code works for 10 minutes. Each chat or Slack user gets 3 wrong
      tries, then it's ignored. After 20 wrong tries in all, pairing stops
      (`pairLocked`) until the person makes a new code
      (`POST /messaging/:app/code`).
  - **Talking to Stars.** "Scout: …" or "@Scout …" picks a Star; otherwise
    the last Star used there answers. `/stars` lists them.
  - **In the app.** Messages show in the Star's chat with `via: 'telegram'`
    or `'slack'`.
  - **Approvals** sent there have Approve and Decline buttons, which only
    the paired person can use.
  - **Other chats.** Messages in other Slack channels or Telegram groups the
    bot is in fire message triggers. They are never chat.
  - **Setup.** Telegram needs a bot from @BotFather. Slack needs an app made
    from `GET /messaging/slack/manifest`, with Socket Mode on: its bot token
    (xoxb-) and an app-level token (xapp-, connections:write).
  - **Old setup still works.** The existing `SKY_TELEGRAM_BOT_TOKEN` and
    `SKY_TELEGRAM_CHAT_ID` setup is two-way too, with no pairing.
- **A Star's own email address.** This uses plus-addressing on the person's
  Gmail, like `d+scout@gmail.com` (`StarView.email`, once Gmail is
  connected).
  - **Incoming mail.** Mail sent, forwarded or CC'd there becomes a one-off
    task for that Star, at most 10 an hour.
  - **Who it's from matters.** From the person, it's their request. From
    anyone else, it's content: the Star summarises or drafts and asks
    before acting.
    - "From the person" means the address inside the From line's `<…>` is
      exactly theirs, and Gmail vouches for it: the mail is in their Sent
      mail, or Gmail's `Authentication-Results` show DKIM passing for their
      domain or SPF passing for their exact address. A display name or a
      look-alike address never counts.
    - The sender's From, Subject and preview go in the brief inside an
      escaped `<email>…</email>` block, one line each, with Sky's own
      guidance after it.
  - **The address stays.** The part after `+` is fixed when first given
    out, so renaming the Star keeps the address.
  - **A real `@yourdomain` address** would need a domain (about $10 a
    year) plus Cloudflare Email Routing. It isn't built.
- **MCP tools.** These are Model Context Protocol servers, through the
  official SDK.
  - **Local or remote.** A local server is a command run on the Sky server
    (stdio). A remote one is reached by URL (Streamable HTTP).
  - **Keeping keys safe.** Environment variables and headers stay on the
    server; the API shows only their names. Values can be
    `{{secret:NAME}}`, filled from the vault when connecting.
  - **Effects.** The person sets each tool's effect (`toolEffects`), and
    the policy decides approvals from it as for any tool. In chat, a Star
    only gets an MCP tool the person set to `read`.
    - The server's own hints (read-only is `read`, destructive is `delete`,
      anything else `write`) are only a suggestion, since a server can say
      anything about itself. Until the person sets a tool's effect
      (`confirmed: false`), every call asks first whatever the autonomy,
      and a tool the server calls read-only counts as a write (so it isn't
      offered in chat).
  - **Tool names.** Tools appear to Stars as `mcp_<server>_<tool>`. If two
    servers' names start the same (the first 20 characters), the one added
    later gets a short tag from its id, like `mcp_company_notes_f_a1b2c_…`.
  - **Errors.** A server's error message never carries its filled-in
    header or env values or a vault secret (some servers repeat the key).
  - **Which Stars.** `Star.mcpServerIds` limits which servers a Star gets
    (null means all of them). Fewer tools help small free models.
- **Group chats.** A conversation with `starIds` (two or more) is a group
  chat.
  - **Who answers.** Stars the person names (@Scout, or "Scout," at the
    start) answer in order. Otherwise one small-model call (on
    `smallProviderIds`) picks one Star.
  - **Bringing others in.** A Star that writes @Name brings that Star in.
    At most two replies per message, to keep model calls down on free
    tiers.
  - **What each Star sees.** The others' messages arrive labelled
    "[Name said]" and are treated as a colleague's words, not
    instructions.
  - **Removing a Star.** The group carries on without it.
- **Templates.** A template is a Star's role, instructions, style, avatar,
  autonomy, apps, its own skills and its own rules. It never includes
  memory, chats or secrets.
  - **Importing.** This makes a new Star, with a unique name. Apps that
    don't exist here are skipped and listed.
  - **A template can't loosen approvals.** It comes from outside, so:
    - its autonomy is used only when it's stricter than the person's own
      (`ask`); otherwise the Star follows the person's setting;
    - its rules are kept with `askOnly: true`: they can make the Star ask
      or stop, never let it skip asking. Rewording a rule makes it the
      person's own.
    - `POST /templates/preview` shows what a template asks for and what
      the Star would get, for a confirm screen before importing.
  - **Built in.** Three templates ship with Sky: Scout, Inbox and Builder.
  - **The gallery** is free: a public GitHub repo (`templateGallery:
    "owner/repo"`) with an `index.json` listing template files, read from
    raw.githubusercontent.com and cached for 30 minutes. Templates come from
    outside, so they're validated strictly.

Free-tier notes for wave 2:

- **Webhooks need a public URL.** Cloudflare Tunnel is free. Telegram,
  Slack, email and MCP don't need one.
- **Gmail is polled, not pushed:** every 3 minutes by default, well inside
  Gmail's free API quota.
- **Telegram groups.** A bot only sees every message in a group with its
  privacy mode off (in @BotFather). Otherwise it sees only commands and
  mentions.
- **Not checked live.** The sandbox this was built in blocks outside hosts,
  so Telegram, Slack and Gmail were tested against faithful fakes (Slack
  through a real WebSocket server), not the live services. MCP was tested
  with a real MCP server over stdio.

## Wave 3: the Star's own computer

Each Star now has a computer of its own: a folder, a terminal and the browser.
The person can step into the browser at any time, and a guard checks every
action that reaches outside.

**Workspace (#1).** Each Star gets a folder, `DATA_DIR/workspaces/<starId>`,
that keeps its files between tasks. The person can browse, upload, download
and delete files through the API. Stars use the tools `files_list`,
`file_read`, `file_write`, `file_delete` and `run_command`. Commands run in
[bubblewrap](https://github.com/containers/bubblewrap) when it's installed and
user namespaces are on:
- The Star's folder is mounted at `/workspace` and is the only place it can write.
- The system's programs and libraries are read-only.
- `/home`, `/root`, `/var`, `/run`, `/mnt` and the server's data folder aren't
  there at all, and `/etc/shadow` is masked.
- No environment variables are passed through, so the server's keys never
  reach a command.
- There's no network unless the call asks for it. A call with network counts
  as a send, so it asks first under balanced autonomy.
- Commands run as uid 1000, with a 2 GB memory limit, a 1 GB file limit and a
  timeout (60 seconds by default, 600 at most).
- Output is cut to the last 8,000 characters. It goes to the model, and to
  the task timeline as the step's detail.

Without bubblewrap (macOS, Windows, a host that blocks user namespaces, or
`SKY_SANDBOX=none`), commands run in the folder with a clean environment but
no sandbox. Every command then asks, whatever the autonomy, at high risk.
Writing and deleting files inside the folder count as writes, because nothing
outside changes. Downloads are served as text, images or PDFs with `nosniff`
and a `sandbox` CSP, so an HTML file a Star made never runs on Sky's own
address.

**Take over and hand back (#5).** The person can take a Star's browser tab
(`POST /browser/:starId/takeover`) and hand it back (`.../handback`, with an
optional note). Using the live view (`/input`) takes control too. That
take-over hands back on its own after 2 minutes without input; an explicit
one lasts 30 minutes. While the person has the tab, a task that calls a
browser tool waits ("Waiting for you to hand the browser back"), and the call
isn't run behind their back. After the hand-back the Star is told what
happened and takes a fresh snapshot. A Star can ask for help itself with
`browser_ask_person` ("Sign in to your bank"): the person gets a "needs you"
message, and the task carries on with their note when they hand back. That
is how sign-ins, captchas and two-factor codes work without passwords.

**Teach a task (#3).** `POST /browser/:starId/record` takes over the tab
(optionally opening a URL) and records what the person does: pages opened,
clicks (labelled with what was clicked), typing (grouped per field), keys,
scrolls and going back. Typing into a password field is stored as
`[password]` and never kept. A recording ends after 10 minutes, at 300 steps,
when the person stops it, or when they hand back. When it ends, a model
drafts a skill (name, when to use it, general steps with placeholders). When
no model is available, the draft is the steps as recorded. The person reviews
the draft and saves it with `POST /recordings/:id/skill`. The skill gets
`source: "taught"`. The save can also take a `schedule`, which sets up a
recurring task that uses the skill.

**The guard (#20).** A second check, separate from the Star doing the work,
runs before the policy on every action that changes something
(write/send/delete/spend). It can only make things stricter:
- **Quick checks** (no model). These block dangerous shell commands (`rm -rf /`, fork
  bombs, writing to disks, remote shells). They ask about piping a download
  into a shell, `sudo`, and background services. They also ask about content
  that tries to instruct an assistant ("ignore previous instructions"), and
  about long encoded blobs leaving in a send.
- **Model review** (`settings.guard: "model"`, the default). Sends, deletes,
  spending, commands with internet and MCP writes are shown to the small
  model chain, with only the person's request and the action. It never sees
  the pages, mail or messages the Star read, so instructions hidden in those
  can't argue with it. It answers ok, ask or block. If it can't be reached or
  its answer is unclear, the guard asks.

A guard "block" is refused like a forbidden rule, and an "ask" becomes a
high-risk approval even under autonomous mode. Both are logged in Activity
with `kind: "guard"`. `guard: "rules"` keeps only the quick checks (no model
calls); `"off"` turns it off.

**Password fill (#17), off by default.** The person saves logins (site,
username, password; encrypted like secrets, never returned). With
`settings.passwordFill` on, Stars get `browser_fill_login`. It fills the
username and password straight into the page; the model, the timeline and
the logs never see the password, and saved passwords are redacted like
secrets wherever they appear. Turning it on relaxes the built-in rule
"Never change passwords or security settings" in exactly one way: a Star may
sign in with a saved login. Everything else stays:
- It only fills on the exact origin the login was saved for, so a look-alike
  site gets nothing.
- It only fills over https (or on this machine).
- It refuses pages with a new-password field or more than one password field,
  which are sign-up and change-password forms.
- Each fill asks first, at high risk, unless the person marks that login
  `autoFill`.
- `browser_type` still refuses password fields.
- Logins can be limited to some Stars.

**Hosting.** Waves 1 and 2 run anywhere. This wave needs an always-on
machine that can run Chromium and bubblewrap: the person's own computer, or
a free cloud VM. `server/README.md` has the steps for Oracle Cloud Always
Free, with its current limits.

## Ideas

Every few hours the runtime offers new ideas: starter ones that follow from
what's connected (tidy the inbox, a calendar heads-up, a weekly "what I
shipped"), and, with Claude, a few grounded in the person's goals, tasks and
recent activity. Each title is offered once; dismissing it keeps it gone.

## Safety

- Content from emails, pages and documents is treated as information, never instructions.
- Chat can't act on the world; only tasks can, and only through the policy.
- Built-in rules can't be edited or deleted (403).
- Tokens never leave the server, and neither do secret values or push keys.
- A secret is only filled into a task's outward tool, after the person approves.
- Messages between Stars are treated like content: information, not instructions.
- With `SKY_PASSWORD` unset the server listens only on localhost.
- Other websites can't use the API through the person's browser. A write
  (POST, PUT, PATCH, DELETE) that a browser marks as coming from another
  site (`Sec-Fetch-Site`, `Origin`) is refused with `403 cross_site`, unless
  the origin is the server itself, `SKY_PUBLIC_URL`, `SKY_WEB_URL` or one of
  `SKY_WEB_ORIGIN`. A body must be JSON (`415 json_only` otherwise), because
  a page can only send text or form bodies without the browser asking first.
  Tools like curl send no browser headers and are let through (they still
  need the password, when one is set). Webhooks (`/hooks/:token`) are exempt.
- With no password, the `Host` must be this machine (localhost, 127.0.0.1)
  or the host of a configured URL, so a site can't point its own name at the
  server (DNS rebinding). Behind a tunnel or another name, set `SKY_PUBLIC_URL`.
- Provider keys are taken out of error messages (`401 Invalid API key: …9999`)
  before they are stored, shown, sent in events or logged, since some
  providers repeat the key. `keyHint` is `null` for keys under 12 characters.
- Secret values need at least 4 characters, so redaction can always hide
  them. Secret values in a browser address or page title are hidden in
  `GET /browser`, `browser.frame` events and approval previews.
- Every model call, including the short ones behind rule checks, lessons,
  ideas and the briefing, gives up after the router's timeout and moves to the
  next provider, so a model that never answers can't hold up the work queue.

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

A Star's live activity comes through `star.activity` (wave 1, below) and the
existing `status` event (`starId` says whose); `star.updated` isn't sent for
every step.

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

### Wave 1 (for the UI to build on)

```ts
// Star gains:
interface Star {
  personality: string;            // up to 1000 characters; '' means none
  replyStyle: string;             // up to 1000 characters
  notify: { whenDone: boolean; whenNeedsYou: boolean };   // defaults false / true
}
interface Skill {
  id: string; name: string; whenToUse: string; steps: string;
  starId: string | null;          // null: every Star
  source: 'you' | 'star' | 'builtIn';
  uses: number; lastUsedAt: string | null; createdAt: string; updatedAt: string;
}
interface Lesson {
  id: string; starId: string; lesson: string;
  trigger: 'declined' | 'edited' | 'failed' | 'chat';
  memoryId?: string; skillId?: string; taskId?: string;
  undone: boolean; createdAt: string;
}
interface Secret {                // never includes the value
  id: string; name: string; description: string;
  starIds: string[] | null; lastUsedAt: string | null; createdAt: string; updatedAt: string;
}
interface PushSubscriptionInfo { id: string; label: string; createdAt: string; lastSentAt: string | null }
// Message gains lessonId?: string ("Got it. I'll remember: …" messages; show an Undo).
// Settings gains:
//   learnFromCorrections: boolean (default true)
//   smallProviderIds: string[] | null (model chain for lessons; null = the Star's own)
//   ntfyTopic: string | null (letters, digits, - and _, up to 64)
//   ntfyServer: string ('' = https://ntfy.sh)
```

| Method | Path | Notes |
| --- | --- | --- |
| POST / PATCH | `/stars`, `/stars/:id` | Also take `personality`, `replyStyle` and `notify` (a partial `notify` keeps the other switch) |
| GET | `/skills?starId=` | `Skill[]`. With `starId`: the skills that Star can use (shared plus its own) |
| POST | `/skills` | `{ name, whenToUse, steps, starId? }` → `Skill` (`source: 'you'`). `409` if the name is taken |
| GET / PATCH / DELETE | `/skills/:id` | PATCH any of those fields. Built-in skills: `403` on PATCH and DELETE |
| GET | `/lessons?starId=` | `Lesson[]`, newest first |
| POST | `/lessons/:id/undo` | → `Lesson` with `undone: true`. Removes the memory, or the skill line it added (later edits stay) |
| GET | `/secrets?starId=` | `{ keySource: 'env' \| 'file' \| 'memory', secrets: Secret[] }` |
| POST | `/secrets` | `{ name, value, description?, starIds? }` → `Secret`. `400` for a bad name, `409` if taken |
| PATCH | `/secrets/:name` | `{ value?, description?, starIds? }` (name or id) → `Secret` |
| DELETE | `/secrets/:name` | `204` |
| GET | `/push/key` | `{ publicKey }`: the `applicationServerKey` for `pushManager.subscribe` |
| GET | `/push/subscriptions` | `PushSubscriptionInfo[]` (device keys stay on the server) |
| POST | `/push/subscriptions` | `{ subscription: <PushSubscription.toJSON()>, label? }` → `PushSubscriptionInfo`. The same endpoint again replaces the old entry |
| DELETE | `/push/subscriptions/:id` | `204` |
| POST | `/push/test` | Sends a test → `{ delivered: string[], failed: string[] }`; `400` when there's nowhere to send |

Push only goes to devices while `settings.channels.push` is on; ntfy goes
whenever `ntfyTopic` is set. A device the push service says is gone (404/410)
is removed. The push payload the service worker receives is JSON:
`{ title, body, url, tag }`, where `url` is a hash route like `#/tasks/t_1`
and `tag` groups notifications about the same task.

Events:

| Event | Data |
| --- | --- |
| `star.activity` | `{ starId, activity: string \| null, taskId: string \| null, at }` |
| `skill.updated` | `Skill` (created or changed, including `uses`) |
| `skill.deleted` | `{ id }` |
| `lesson.learned` | `Lesson` |
| `lesson.undone` | `Lesson` |

### Wave 2 (for the UI to build on)

```ts
// Task gains trigger?: TaskTrigger. CreateTaskInput gains trigger (kind must be 'recurring'; schedule optional).
interface TaskTrigger {
  kind: 'webhook' | 'github' | 'message' | 'email';
  events?: string[];                              // github: e.g. ['push', 'issues']; empty = every event
  source?: 'slack' | 'telegram' | 'any';          // message
  match?: string;                                 // message: must contain (case-insensitive)
  channel?: string;                               // message: Slack channel id or #name, Telegram chat id
  query?: string;                                 // email: Gmail search
  fired: number; lastFiredAt: string | null;
}
interface TriggerSetup extends TaskTrigger { url: string | null; secret: string | null }   // url for webhook/github; secret for github
interface TriggerEvent { id: string; taskId: string; source: string; summary: string; content: string; at: string }
// Conversation gains starIds?: string[] (a group chat). Message gains via?: 'telegram' | 'slack'.
// Star gains mcpServerIds: string[] | null. StarView gains email: string | null.
interface MessagingStatus {
  app: 'telegram' | 'slack';
  state: 'off' | 'pairing' | 'on' | 'error';
  pairCode: string | null;                        // show while pairing: "Send 482913 to your bot"
  pairLink: string | null;                        // telegram: https://t.me/<bot>?start=<code>
  botName: string | null;                         // telegram bot username, or the Slack workspace
  error: string | null;
}
interface McpServer {
  id: string; name: string; transport: 'stdio' | 'http';
  command: string | null; args: string[]; url: string | null;
  envKeys: string[]; headerKeys: string[];        // names only; values stay on the server
  enabled: boolean; toolEffects: Record<string, 'read' | 'write' | 'send' | 'delete' | 'spend'>;
  status: 'off' | 'connecting' | 'ready' | 'error'; error: string | null;
  tools: { name: string; toolName: string; description: string; effect: string }[];
  createdAt: string; updatedAt: string;
}
interface StarTemplate {
  format: 'sky.star'; version: 1; name: string; role: string; description?: string;
  instructions: string; personality: string; replyStyle: string;
  avatar: { character; color }; autonomy: Autonomy | null; apps: string[] | null;
  skills: { name: string; whenToUse: string; steps: string }[]; rules: string[];
}
interface TemplateEntry { id: string; source: 'builtIn' | 'gallery'; template: StarTemplate; url?: string }
// Settings gains mailPollMinutes (2–60, default 3) and templateGallery ('' | 'owner/repo' | https URL to index.json).
```

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/tasks` | Also takes `trigger` (see above) |
| GET | `/tasks/:id/trigger` | `TriggerSetup`; `404` without a trigger |
| PUT | `/tasks/:id/trigger` | `{ trigger }` → `TriggerSetup`, or `{ trigger: null }` to remove it. One-off tasks: `400` |
| POST | `/tasks/:id/trigger/rotate` | New URL and secret → `TriggerSetup` |
| GET | `/tasks/:id/events` | `TriggerEvent[]` still waiting for a run |
| POST | `/triggers/check-mail` | Checks Gmail now instead of waiting for the next poll |
| POST | `/hooks/:token` | **No sign-in.** The webhook URL. `202` accepted, `404` unknown or paused, `401` bad GitHub signature, `429` over 30 an hour |
| GET | `/messaging` | `MessagingStatus[]` (telegram, slack) |
| POST | `/messaging/telegram` | `{ botToken }` → `MessagingStatus` (pairing). `400` if Telegram rejects the token |
| POST | `/messaging/slack` | `{ botToken, appToken }` → `MessagingStatus` (pairing) |
| DELETE | `/messaging/telegram`, `/messaging/slack` | → `MessagingStatus` (off) |
| GET | `/messaging/slack/manifest` | A Slack app manifest to paste into "Create an app → From a manifest" |
| GET / POST | `/mcp` | `McpServer[]`; POST `{ name, transport, command?, args?, url?, env?, headers?, enabled?, toolEffects? }` → `McpServer` (connects in the background) |
| GET / PATCH / DELETE | `/mcp/:id` | PATCH any field; changing how it's reached reconnects. DELETE also removes it from every Star |
| POST | `/mcp/:id/reconnect` | → `McpServer` |
| POST / PATCH | `/stars`, `/stars/:id` | Also take `mcpServerIds` |
| POST | `/conversations` | `{ starIds: [...], title? }` makes a group chat (two or more Stars) |
| PATCH | `/conversations/:id` | `{ title?, starIds? }` (starIds for group chats only) |
| GET | `/conversations?starId=` | Now also lists the group chats that Star is in |
| GET | `/templates` | `{ templates: TemplateEntry[], galleryError: string \| null }` |
| GET | `/stars/:id/template` | `StarTemplate` (offer it as a `.sky-star.json` download) |
| POST | `/templates/import` | `{ template }`, `{ id }` (from `/templates`) or `{ url }` (https) → `{ star: StarView, skipped: string[] }` |

In a group chat each agent message carries the `starId` of the Star that
wrote it, and replies stream one after another as usual (`message.delta`,
`message.done`).

Events: `mcp.updated` (`McpServer`), `mcp.deleted` (`{ id }`),
`messaging.updated` (`MessagingStatus`). Triggered runs show up through the
usual `task.updated` and `task.step` ("Triggered by webhook"; what the
sender wrote, like a JSON title or an email subject, is the step's `detail`,
so it stays out of the next run's brief).

Round 4 fixes (testing thread, bugs 19 to 27), changes to the shapes above:

```ts
interface MessagingStatus { /* … */ pairExpiresAt: string | null; pairLocked: boolean }
// pairCode is null once it expired or pairLocked; offer "Make a new code" (POST /messaging/:app/code).
interface McpToolInfo { name; toolName; description; effect; hint: McpEffect; confirmed: boolean }
// effect: the person's choice, or the server's hint while confirmed is false. Show unconfirmed tools as
// "Asks every time until you choose", with the hint as the suggestion.
// Rule gains askOnly?: boolean (came with a template: can only make a Star ask or stop).
interface TemplatePreview {
  template: StarTemplate;
  wants: { autonomy: Autonomy | null; apps: string[] | null; rules: string[]; skills: string[] };
  gets: { autonomy: Autonomy | null; connectionIds: string[] | null; rulesAskOnly: boolean };
  skipped: string[];
}
```

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/messaging/telegram/code`, `/messaging/slack/code` | A fresh pairing code → `MessagingStatus`. `400` when already paired |
| POST | `/templates/preview` | Same body as import → `TemplatePreview`. Makes nothing |

Changing `mailPollMinutes` now takes effect straight away.

Round 3 fixes (testing thread): see Safety above for cross-site requests,
key scrubbing, short secrets and timeouts. A provider is benched for 6 hours
only for an unknown or retired model name; "not supported with this model"
and similar move on to the next provider without benching it. Push
subscriptions must point at a public https push service.

Fixes from the UI's reports: a live-browser `navigate` to something that
isn't an http(s) address (like `data:` or `javascript:`) is a `400` with a
message, and a page that won't load is a `400` (`page_failed`) with the reason. If the
browser can't start, `GET /browser` says why (`ok: false` and a `reason`),
and the input endpoints return `503` with the same message. A correction as
the very first chat message ("Actually, always reply in English") now
becomes a lesson too.

### Wave 3 (for the UI to build on)

Types (in `server/src/types.ts`): `BrowserSession` gains `control:
'star'|'person'`, `controlNote`, `waitingTaskId` and `recordingId`.
`Recording`, `RecordedStep`, `WorkspaceFile`, `WorkspaceStatus`, `SavedLogin`
and `GuardDecision` are new. `Skill.source` can be `'taught'`. Settings gain
`guard?: 'model'|'rules'|'off'` (default `model`) and `passwordFill?: boolean`
(default `false`). The new activity kinds are `guard` and `browser` (taken
over or handed back); the server's `ServerActivityKind` adds them to
`ActivityKind`.

Browser:
- `POST /browser/:starId/takeover` `{ note? }` → `BrowserSession` with `control: "person"`.
- `POST /browser/:starId/handback` `{ note? }` → `BrowserSession` with
  `control: "star"`. A task waiting on it carries on with the note. `409` if
  the tab isn't open.
- `POST /browser/:starId/input` now takes control for the person if the Star
  had it (it goes back after 2 idle minutes). A page that won't load is `400 page_failed`.
- The live view should show "Take over / Hand back" from `control`, and the
  `controlNote` (what the Star asked for) while `waitingTaskId` is set.

Teach a task:
- `POST /browser/:starId/record` `{ title?, url? }` → `Recording`
  (`status: "recording"`). `409` while one is already recording for that Star.
- `POST /browser/:starId/record/stop` → `Recording` (`status: "done"`, with
  `draft: { name, whenToUse, steps }` or `null` if nothing was recorded).
  Handing back also stops it; the draft then arrives as `recording.updated`.
- `GET /recordings?starId=`, `GET /recordings/:id`, `DELETE /recordings/:id`.
- `POST /recordings/:id/skill` `{ name?, whenToUse?, steps?, shared?, schedule? }`
  → `{ recording, skill, task }`. Missing fields come from the draft.
  `shared: true` gives the skill to every Star. `task` is the recurring task,
  or `null`. `409` if the recording is already a skill.

Workspace:
- `GET /workspace` → `WorkspaceStatus` (`sandbox: "bwrap"|"none"`, `reason`, `root`).
- `GET /stars/:id/files?path=&recursive=1` → `{ files: WorkspaceFile[], usage }` (bytes).
- `GET /stars/:id/files/content?path=` downloads a file (`&download=1` for
  an attachment). Text and code come back as `text/plain`.
- `PUT /stars/:id/files/content?path=` uploads a file: the raw file is the
  body, with its own content type (not `text/plain` or form types), up to
  10 MB. Returns the `WorkspaceFile`.
- `DELETE /stars/:id/files?path=` deletes a file or folder.
- A path outside the folder, including through a symlink, is a `400`.
- Commands show as task steps: "Ran \`…\` (exit 0)", with the output in `detail`.

Saved logins:
- `GET /logins` → `{ enabled, logins: SavedLogin[] }`.
- `POST /logins` `{ origin, username, password, starIds?, autoFill? }`. The
  origin must be https (`http://localhost` is fine for trying it out); `409`
  for a duplicate.
- `PATCH /logins/:id` `{ username?, password?, starIds?, autoFill? }`, `DELETE /logins/:id`.
- The opt-in switch is `PATCH /settings { passwordFill: true }`. The UI
  should say what turning it on relaxes (see Wave 3 above).

Guard: `PATCH /settings { guard: "model" | "rules" | "off" }`. Its decisions
appear in Activity (`kind: "guard"`), as a task step ("The guard wants your
OK: …") and in the approval's `reason`.

Events: `browser.control` (`BrowserSession`), `recording.updated`
(`Recording`), `workspace.changed` (`{ starId, path }`).

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
