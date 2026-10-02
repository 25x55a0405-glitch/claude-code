// Data model shared between the Sky web UI and the back end.
// docs/API.md describes the HTTP endpoints that carry these shapes.
// All timestamps are ISO 8601 strings in UTC. All ids are opaque strings.

export type AgentState = 'idle' | 'working' | 'waiting' | 'paused' | 'offline';

/** How much Sky may do without asking first. */
export type Autonomy = 'ask' | 'balanced' | 'autonomous';

export interface AgentStatus {
  state: AgentState;
  /** One line describing what Sky is doing right now, shown under the orb. */
  activity: string | null;
  /** Task the current activity belongs to, if any. */
  taskId: string | null;
  since: string;
  autonomy: Autonomy;
  /** The Star doing the current activity, if any. */
  starId?: string | null;
  counts: {
    activeTasks: number;
    pendingApprovals: number;
    completedToday: number;
  };
}

export type HighlightKind = 'done' | 'found' | 'needs_you' | 'upcoming' | 'warning';

export interface BriefingHighlight {
  id: string;
  kind: HighlightKind;
  title: string;
  detail: string;
  taskId?: string;
  approvalId?: string;
}

export interface Briefing {
  id: string;
  generatedAt: string;
  greeting: string;
  summary: string;
  highlights: BriefingHighlight[];
}

// ---- Tasks -------------------------------------------------------------

export type TaskStatus =
  | 'active'
  | 'scheduled'
  | 'waiting_approval'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'failed';

/** one_off runs once, recurring runs on a schedule, watch monitors something and acts on change. */
export type TaskKind = 'one_off' | 'recurring' | 'watch';

export type StepKind = 'plan' | 'thought' | 'action' | 'tool' | 'result' | 'approval' | 'error' | 'note';

export interface TaskStep {
  id: string;
  at: string;
  kind: StepKind;
  summary: string;
  /** Optional longer text or tool output, rendered collapsible. */
  detail?: string;
  /** Connection used for this step, if any. */
  connectionId?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  kind: TaskKind;
  /** Human-readable schedule for recurring and watch tasks, e.g. "Weekdays at 8:00". */
  schedule?: string;
  /** 0..1, omitted when progress is not measurable. */
  progress?: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  connectionIds: string[];
  /** What starts a run besides (or instead of) the schedule. */
  trigger?: TaskTrigger;
  /** Short line summarising the latest outcome, shown on cards. */
  lastOutcome?: string;
  /** The Star that owns the task. */
  starId?: string;
  /** Set when another Star asked for this work with ask_star or hand_off. */
  requestedBy?: { starId: string; taskId?: string; depth?: number };
}

export interface TaskDetail extends Task {
  steps: TaskStep[];
}

export interface CreateTaskInput {
  title: string;
  description: string;
  kind: TaskKind;
  schedule?: string;
  starId?: string;
  /** Recurring tasks only. */
  trigger?: TriggerInput;
}

export type TriggerKind = 'webhook' | 'github' | 'message' | 'email';

export interface TaskTrigger {
  kind: TriggerKind;
  /** github: e.g. ['push', 'issues']; empty means every event. */
  events?: string[];
  /** message: where it listens. */
  source?: 'slack' | 'telegram' | 'any';
  /** message: must contain this (case-insensitive). */
  match?: string;
  /** message: Slack channel id or #name, Telegram chat id. */
  channel?: string;
  /** email: a Gmail search. */
  query?: string;
  fired: number;
  lastFiredAt: string | null;
}

export type TriggerInput = Omit<TaskTrigger, 'fired' | 'lastFiredAt'>;

/** A trigger with the URL and secret to paste elsewhere. */
export interface TriggerSetup extends TaskTrigger {
  url: string | null;
  secret: string | null;
}

/** An event waiting for its run. */
export interface TriggerEvent {
  id: string;
  taskId: string;
  source: string;
  summary: string;
  content: string;
  at: string;
}

export type TaskCommand = 'pause' | 'resume' | 'run_now' | 'cancel';

// ---- Approvals ---------------------------------------------------------

export type Risk = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  taskId?: string;
  /** Verb phrase, e.g. "Send email". */
  action: string;
  /** Who or what the action touches, e.g. "maya@studio.co". */
  target: string;
  /** Why Sky wants to do this. */
  reason: string;
  /** Exact content that will be sent or changed. */
  preview: string;
  connectionId?: string;
  risk: Risk;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
  starId?: string;
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject';
  /** Optional edited preview to use instead of the original (approve only). */
  editedPreview?: string;
  /** Optional note for Sky, which it should remember. */
  note?: string;
}

// ---- Conversations -----------------------------------------------------

export type Role = 'user' | 'agent' | 'system';

export interface Conversation {
  id: string;
  /** The one long main chat. Every other conversation is a side chat. */
  main: boolean;
  title: string;
  updatedAt: string;
  preview: string;
  starId?: string;
  /** Two or more Stars: a group chat. */
  starIds?: string[];
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  status: 'streaming' | 'done' | 'error';
  /** True when Sky reached out on its own rather than replying. */
  proactive?: boolean;
  /** Structured cards rendered under the message text. */
  cards?: MessageCard[];
  /** The Star that wrote an agent message. */
  starId?: string;
  /** Came in from a messaging app. */
  via?: 'telegram' | 'slack';
  /** Set on "Got it. I'll remember: …" messages, so the UI can offer Undo. */
  lessonId?: string;
}

/** A task or approval shown inline in the chat, like Muse's approval cards. */
export type MessageCard = { kind: 'task'; taskId: string } | { kind: 'approval'; approvalId: string };

// ---- Memory ------------------------------------------------------------

export type MemoryCategory = 'preference' | 'fact' | 'person' | 'goal' | 'style';

export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  content: string;
  /** Where Sky learned it, e.g. "Chat on Sep 30" or "Gmail". */
  source: string;
  createdAt: string;
  pinned: boolean;
  /** Private to one Star; absent or null means every Star shares it. */
  starId?: string | null;
}

// ---- Connections -------------------------------------------------------

export type ConnectionStatus = 'connected' | 'expired' | 'disconnected';
export type Access = 'read' | 'read_write';

export interface Connection {
  id: string;
  /** Stable provider key, e.g. "gmail", "calendar", "github". */
  provider: string;
  name: string;
  description: string;
  status: ConnectionStatus;
  access: Access;
  lastSyncAt?: string;
}

// ---- Rules -------------------------------------------------------------

export interface Rule {
  id: string;
  text: string;
  enabled: boolean;
  /** Built-in rules cannot be deleted or disabled. */
  builtIn: boolean;
  createdAt: string;
  /** Applies to one Star only; absent or null means every Star. */
  starId?: string | null;
}

// ---- Activity ----------------------------------------------------------

export type ActivityKind =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'memory_learned'
  | 'research'
  | 'message';

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  summary: string;
  taskId?: string;
  starId?: string;
}

// ---- Settings ----------------------------------------------------------

export type Tone = 'warm' | 'concise' | 'playful' | 'formal';
export type AvatarCharacter = 'cloud' | 'dot' | 'drop';
export type AvatarColor = 'sky' | 'peach' | 'mint' | 'lilac' | 'sun';

export interface Settings {
  userName: string;
  agentName: string;
  avatar: { character: AvatarCharacter; color: AvatarColor };
  tone: Tone;
  timezone: string;
  autonomy: Autonomy;
  /** Local time "HH:MM" when the daily briefing is prepared, or null to turn it off. */
  briefingTime: string | null;
  quietHours: { enabled: boolean; start: string; end: string };
  proactiveResearch: boolean;
  channels: { web: boolean; email: boolean; push: boolean; slack: boolean; telegram: boolean };
  /** Stars turn corrections into lessons. Absent on older servers. */
  learnFromCorrections?: boolean;
  /** The model chain used to write lessons; null means the Star's own. */
  smallProviderIds?: string[] | null;
  /** ntfy topic for phone notifications, or null when off. */
  ntfyTopic?: string | null;
  /** '' means https://ntfy.sh. */
  ntfyServer?: string;
  /** How often email triggers check Gmail, 2 to 60. */
  mailPollMinutes?: number;
  /** '' | 'owner/repo' | an https URL to index.json. */
  templateGallery?: string;
}

// ---- Ideas -------------------------------------------------------------

export type IdeaKind = 'suggestion' | 'tip' | 'plan_update';

/** Something Sky thinks it could do for you, based on your goals and patterns. */
export interface Idea {
  id: string;
  kind: IdeaKind;
  title: string;
  detail: string;
  /** What gets sent to the main chat when you say "Do it". */
  prompt: string;
  createdAt: string;
}

// ---- Stars and the constellation --------------------------------------

/**
 * A Star is one of the person's agents. Each has its own role, instructions,
 * memory, apps, rules, autonomy and chat; together they form a constellation
 * that can ask each other for help and hand work over.
 */
export interface Star {
  id: string;
  name: string;
  /** One line: what this Star is for, e.g. "Finds and compares flights". */
  role: string;
  /** Longer standing instructions, like a job description. */
  instructions: string;
  avatar: { character: AvatarCharacter; color: AvatarColor };
  /** The first Star. It can't be deleted and its name is Settings.agentName. */
  main: boolean;
  /** null means use the global autonomy from Settings. */
  autonomy: Autonomy | null;
  /** Connection ids this Star may use; null means every connected app. */
  connectionIds: string[] | null;
  paused: boolean;
  /** Model providers this Star uses, in order; null means the global order. Absent on older servers. */
  providerIds?: string[] | null;
  /** MCP servers this Star gets; null means all. Absent on older servers. */
  mcpServerIds?: string[] | null;
  /** Its character, in its own words. '' means none. Absent on older servers. */
  personality?: string;
  /** How its replies look: length, format, emoji. */
  replyStyle?: string;
  /** When it pings you on your devices. Defaults: whenDone off, whenNeedsYou on. */
  notify?: { whenDone: boolean; whenNeedsYou: boolean };
  /** This Star's own chat (for the main Star, the main chat). */
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StarStatus {
  state: AgentState;
  activity: string | null;
  taskId: string | null;
  activeTasks: number;
  pendingApprovals: number;
}

/** What the API returns for a Star: the record plus its live status. */
export interface StarView extends Star {
  status: StarStatus;
  /** Its own address (plus-addressing on your Gmail), once Gmail is connected. */
  email?: string | null;
}

export type StarInput = Pick<Star, 'name' | 'role'> & Partial<Pick<Star, 'instructions' | 'avatar' | 'autonomy' | 'connectionIds' | 'providerIds' | 'personality' | 'replyStyle' | 'mcpServerIds'>> & { notify?: Partial<NonNullable<Star['notify']>> };

export type ConstellationMessageKind = 'message' | 'request' | 'reply' | 'handoff';

/** One Star talking to another. */
export interface ConstellationMessage {
  id: string;
  fromStarId: string;
  toStarId: string;
  /** request: ask_star asked for help; reply: the answer; handoff: work passed over; message: an FYI. */
  kind: ConstellationMessageKind;
  content: string;
  /** The task the message is about (the new task for request and handoff). */
  taskId?: string;
  createdAt: string;
  /** Whether the receiving Star has seen it yet. */
  read: boolean;
}

// ---- Model providers --------------------------------------------------

/** anthropic: the Anthropic Messages format. openai: the Chat Completions format. */
export type ProviderKind = 'anthropic' | 'openai';

export interface ProviderHealth {
  /** unknown: not used yet; ok: last call worked; cooling: skipped until cooldownUntil; failing: needs fixing (bad key, unknown model). */
  state: 'unknown' | 'ok' | 'cooling' | 'failing';
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  cooldownUntil: string | null;
  /** Failures in a row. */
  failures: number;
  latencyMs: number | null;
}

/** A model the Stars can think with. The API key never leaves the server. */
export interface ModelProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  /** Last four characters of the key, for recognising it. */
  keyHint: string | null;
  /** Comes from the server's ANTHROPIC_API_KEY; can't be edited or removed here. */
  builtIn: boolean;
  health: ProviderHealth;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPreset {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** An example model id; providers change their lists often. */
  exampleModel: string;
  needsKey: boolean;
  keyUrl: string | null;
  note: string;
}

/** apiKey is write-only: send a string to set it, null to remove it, or leave it out to keep it. */
export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  enabled?: boolean;
}

export interface ProviderTest {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

// ---- Browser ----------------------------------------------------------

/** A Star's tab in the shared real browser. */
export interface BrowserSession {
  starId: string;
  url: string;
  title: string;
  /** Changes whenever a new screenshot is ready. */
  frameId: string | null;
  updatedAt: string;
}

export interface BrowserState {
  ok: boolean;
  running: boolean;
  /** Why the browser can't start, when it can't. */
  reason?: string | null;
  sessions: BrowserSession[];
}

/** What the person does in a Star's tab. Clicks are in the 1280×800 page. */
export type BrowserInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' };

// ---- Skills, lessons, secrets, push -----------------------------------

export type SkillSource = 'you' | 'star' | 'builtIn';

/** A saved recipe a Star can follow. */
export interface Skill {
  id: string;
  name: string;
  whenToUse: string;
  steps: string;
  /** null: every Star can use it. */
  starId: string | null;
  source: SkillSource;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SkillInput = Pick<Skill, 'name' | 'whenToUse' | 'steps'> & { starId?: string | null };

/** Something a Star took away from a correction. */
export interface Lesson {
  id: string;
  starId: string;
  lesson: string;
  trigger: 'declined' | 'edited' | 'failed' | 'chat';
  memoryId?: string;
  skillId?: string;
  taskId?: string;
  undone: boolean;
  createdAt: string;
}

/** A stored secret. The value never comes back. */
export interface Secret {
  id: string;
  name: string;
  description: string;
  /** null: every Star. */
  starIds: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecretList {
  /** Where the encryption key lives. memory: it's lost when the server restarts. */
  keySource: 'env' | 'file' | 'memory';
  secrets: Secret[];
}

export interface SecretInput {
  name: string;
  value: string;
  description?: string;
  starIds?: string[] | null;
}

export interface PushSubscriptionInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSentAt: string | null;
}

export interface PushTestResult {
  delivered: string[];
  failed: string[];
}

// ---- Messaging apps, MCP, templates -----------------------------------

export type MessagingApp = 'telegram' | 'slack';

export interface MessagingStatus {
  app: MessagingApp;
  state: 'off' | 'pairing' | 'on' | 'error';
  /** Show while pairing: "Send 482913 to your bot". */
  pairCode: string | null;
  /** telegram: https://t.me/<bot>?start=<code> */
  pairLink: string | null;
  /** Telegram bot username, or the Slack workspace. */
  botName: string | null;
  error: string | null;
}

export type ToolEffect = 'read' | 'write' | 'send' | 'delete' | 'spend';

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  /** Names only; values stay on the server. */
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  toolEffects: Record<string, ToolEffect>;
  status: 'off' | 'connecting' | 'ready' | 'error';
  error: string | null;
  tools: { name: string; toolName: string; description: string; effect: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface McpInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolEffects?: Record<string, ToolEffect>;
}

export interface StarTemplate {
  format: 'sky.star';
  version: 1;
  name: string;
  role: string;
  description?: string;
  instructions: string;
  personality: string;
  replyStyle: string;
  avatar: { character: AvatarCharacter; color: AvatarColor };
  autonomy: Autonomy | null;
  apps: string[] | null;
  skills: { name: string; whenToUse: string; steps: string }[];
  rules: string[];
}

export interface TemplateEntry {
  id: string;
  source: 'builtIn' | 'gallery';
  template: StarTemplate;
  url?: string;
}

// ---- Pagination --------------------------------------------------------

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, null when there are no more. */
  nextCursor: string | null;
}

// ---- Live events (Server-Sent Events) ----------------------------------

export type LiveEvent =
  | { type: 'status'; data: AgentStatus }
  | { type: 'task.updated'; data: Task }
  | { type: 'task.step'; data: { taskId: string; step: TaskStep } }
  | { type: 'approval.created'; data: Approval }
  | { type: 'approval.updated'; data: Approval }
  | { type: 'message.delta'; data: { conversationId: string; messageId: string; delta: string } }
  | { type: 'message.done'; data: Message }
  | { type: 'activity'; data: ActivityEvent }
  | { type: 'memory.learned'; data: MemoryItem }
  | { type: 'idea.created'; data: Idea }
  | { type: 'settings.updated'; data: Settings }
  | { type: 'provider.updated'; data: ModelProvider }
  | { type: 'provider.deleted'; data: { id: string } }
  | { type: 'browser.frame'; data: BrowserSession }
  | { type: 'star.updated'; data: StarView }
  | { type: 'star.deleted'; data: { id: string } }
  | { type: 'constellation.message'; data: ConstellationMessage }
  | { type: 'star.activity'; data: { starId: string; activity: string | null; taskId: string | null; at: string } }
  | { type: 'skill.updated'; data: Skill }
  | { type: 'skill.deleted'; data: { id: string } }
  | { type: 'lesson.learned'; data: Lesson }
  | { type: 'lesson.undone'; data: Lesson }
  | { type: 'mcp.updated'; data: McpServer }
  | { type: 'mcp.deleted'; data: { id: string } }
  | { type: 'messaging.updated'; data: MessagingStatus };

export type LiveEventType = LiveEvent['type'];

export interface ApiError {
  error: { code: string; message: string };
}
