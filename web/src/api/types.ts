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
}

export type StarInput = Pick<Star, 'name' | 'role'> & Partial<Pick<Star, 'instructions' | 'avatar' | 'autonomy' | 'connectionIds'>>;

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
  | { type: 'star.updated'; data: StarView }
  | { type: 'star.deleted'; data: { id: string } }
  | { type: 'constellation.message'; data: ConstellationMessage };

export type LiveEventType = LiveEvent['type'];

export interface ApiError {
  error: { code: string; message: string };
}
