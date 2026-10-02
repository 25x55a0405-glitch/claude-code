// The data model is shared with the web UI: web/src/api/types.ts is the
// single source of truth for every shape the API returns. The server adds
// Stars (Sky's agents) and constellation messages here; they're documented in
// docs/BACKEND.md until the UI adopts them into the shared file.
import type { AgentState, Autonomy, AvatarCharacter, AvatarColor, LiveEvent } from '../../web/src/api/types.ts';

export type * from '../../web/src/api/types.ts';

/** Fields the server adds to the shared shapes. All optional, so the UI can ignore them. */
declare module '../../web/src/api/types.ts' {
  interface AgentStatus {
    /** The Star doing the current activity, if any. */
    starId?: string | null;
  }
  interface Task {
    /** The Star that owns the task. */
    starId?: string;
    /** Set when another Star asked for this work with ask_star or hand_off. */
    requestedBy?: { starId: string; taskId?: string; depth?: number };
  }
  interface CreateTaskInput {
    starId?: string;
    /** Run on an event (see TaskTrigger). Needs kind "recurring"; the schedule is then optional. */
    trigger?: unknown;
  }
  interface Approval {
    starId?: string;
  }
  interface Conversation {
    starId?: string;
  }
  interface Message {
    /** The Star that wrote an agent message. */
    starId?: string;
  }
  interface ActivityEvent {
    starId?: string;
  }
  interface MemoryItem {
    /** Private to one Star; absent or null means every Star shares it. */
    starId?: string | null;
  }
  interface Rule {
    /** Applies to one Star only; absent or null means every Star. */
    starId?: string | null;
  }
  interface Message {
    /** Set on the "Got it, I'll…" note a Star posts after learning from a correction. */
    lessonId?: string;
  }
  interface Settings {
    /** Reflect on declined or edited approvals, failed tasks and "no, like this" in chat. Default true. */
    learnFromCorrections?: boolean;
    /** A cheaper provider chain for background calls like reflection; null uses each Star's own. */
    smallProviderIds?: string[] | null;
    /** ntfy topic for phone notifications (https://ntfy.sh/<topic>); null turns ntfy off. */
    ntfyTopic?: string | null;
    /** A self-hosted ntfy server instead of ntfy.sh. */
    ntfyServer?: string;
    /** How often Sky checks Gmail for Star mail and email triggers, in minutes (2 to 60). */
    mailPollMinutes?: number;
    /** Where the template gallery lives: a GitHub "owner/repo", or an https URL to an index.json. Empty: built-in templates only. */
    templateGallery?: string;
  }
  interface Task {
    /** Runs the task when something happens, as well as (or instead of) its schedule. */
    trigger?: TaskTrigger;
  }
  interface Conversation {
    /** A group chat: the person and these Stars (two or more). Absent for one-Star chats. */
    starIds?: string[];
  }
  interface Message {
    /** Where the person wrote this, when it wasn't the app. */
    via?: 'telegram' | 'slack';
  }
}

/**
 * What starts a triggered task:
 *  - webhook: any service POSTs to the task's secret URL
 *  - github: a GitHub webhook to that URL, signed with the task's secret, filtered by event
 *  - message: a message in a Slack channel or Telegram group the bot is in, containing `match`
 *  - email: a new Gmail message matching a search
 * What arrives is handed to the Star as content to work with, never as instructions.
 */
export interface TaskTrigger {
  kind: 'webhook' | 'github' | 'message' | 'email';
  /** github: event names like "push", "issues", "pull_request"; empty means every event. */
  events?: string[];
  /** message: where to listen. */
  source?: 'slack' | 'telegram' | 'any';
  /** message: only messages containing this text (case-insensitive); empty means every message. */
  match?: string;
  /** message: a Slack channel id or Telegram chat id to limit it to. */
  channel?: string;
  /** email: a Gmail search, like "from:alerts@bank.com subject:statement". */
  query?: string;
  fired: number;
  lastFiredAt: string | null;
}

/** One thing that happened, waiting to be handled by its task. */
export interface TriggerEvent {
  id: string;
  taskId: string;
  /** Where it came from: "webhook", "github push", "Slack #general", "email". */
  source: string;
  /** One line for the timeline. */
  summary: string;
  /** What arrived, trimmed. Content to work with, not instructions. */
  content: string;
  at: string;
}

/** What the API returns for a task's trigger, including what to paste into the other service. */
export interface TriggerSetup extends TaskTrigger {
  /** webhook and github: the URL to call. */
  url: string | null;
  /** github: the secret to paste into the webhook's settings. */
  secret: string | null;
}

/** A Model Context Protocol server whose tools the Stars can use. */
export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: the command and its arguments, run on the Sky server. */
  command: string | null;
  args: string[];
  /** http: the server's URL (Streamable HTTP). */
  url: string | null;
  /** Names of the environment variables (stdio) or headers (http) set; values stay on the server. Values may be {{secret:NAME}}. */
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  /** Overrides for what a tool does, which decides when it needs approval. */
  toolEffects: Record<string, McpEffect>;
  status: 'off' | 'connecting' | 'ready' | 'error';
  error: string | null;
  tools: McpToolInfo[];
  createdAt: string;
  updatedAt: string;
}

export type McpEffect = 'read' | 'write' | 'send' | 'delete' | 'spend';

export interface McpToolInfo {
  /** The name the server uses. */
  name: string;
  /** The name the Stars see: mcp_<server>_<tool>. */
  toolName: string;
  description: string;
  effect: McpEffect;
}

/** A shareable Star: everything but its memory, chats and secrets. */
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
  /** Connection ids it works with; null means every connected app. */
  apps: string[] | null;
  skills: { name: string; whenToUse: string; steps: string }[];
  rules: string[];
}

/** A template on offer: built in, or from the gallery. */
export interface TemplateEntry {
  id: string;
  source: 'builtIn' | 'gallery';
  template: StarTemplate;
  /** gallery: where it was read from. */
  url?: string;
}

/** A messaging app the person can talk to their Stars through. */
export interface MessagingStatus {
  app: 'telegram' | 'slack';
  /** off: not set up; pairing: waiting for the person's first message with the code; on: working. */
  state: 'off' | 'pairing' | 'on' | 'error';
  /** pairing: send this to the bot. */
  pairCode: string | null;
  /** telegram: a link that opens the bot with the code filled in. */
  pairLink: string | null;
  /** The bot's name in the app. */
  botName: string | null;
  error: string | null;
}

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
  /** Model providers this Star uses, in order; null means the global order. */
  providerIds: string[] | null;
  /** Free-text character, added to the tone preset ("dry humour, never uses emoji"). Empty: none. */
  personality: string;
  /** How replies should look ("short bullet points", "always end with a next step"). Empty: none. */
  replyStyle: string;
  /** When this Star pushes to your devices (Web Push and ntfy). */
  notify: { whenDone: boolean; whenNeedsYou: boolean };
  /** MCP servers this Star may use; null means every enabled server. */
  mcpServerIds: string[] | null;
  /** This Star's own chat (for the main Star, the main chat). */
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StarStatus {
  state: AgentState;
  /** Short present-tense phrase for under the avatar ("Reading your inbox"), from a task or a chat reply. */
  activity: string | null;
  taskId: string | null;
  activeTasks: number;
  pendingApprovals: number;
}

/** What the API returns for a Star: the record plus its live status. */
export interface StarView extends Star {
  status: StarStatus;
  /** The Star's own address (plus-addressing on the person's Gmail), once Gmail is connected. */
  email: string | null;
}

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

// ---- Model providers --------------------------------------------------------

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

// ---- Skills -------------------------------------------------------------------

/** A saved, editable recipe for doing a kind of task. */
export interface Skill {
  id: string;
  name: string;
  /** When a Star should reach for it. Shown in the prompt; the steps are read on use. */
  whenToUse: string;
  /** The recipe, as plain text or Markdown. */
  steps: string;
  /** Belongs to one Star; null means every Star can use it. */
  starId: string | null;
  /** you: written by the person; star: saved by a Star; builtIn: ships with Sky and can't be changed. */
  source: 'you' | 'star' | 'builtIn';
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Learning -----------------------------------------------------------------

/** Something a Star learned from a correction, which the person can undo. */
export interface Lesson {
  id: string;
  starId: string;
  /** What it will do differently, one sentence ("Keep emails to Maya under five lines"). */
  lesson: string;
  /** What prompted it. */
  trigger: 'declined' | 'edited' | 'failed' | 'chat';
  /** Where it went: a new memory, or a line added to a skill. */
  memoryId?: string;
  skillId?: string;
  taskId?: string;
  undone: boolean;
  createdAt: string;
}

// ---- Secrets ------------------------------------------------------------------

/** A stored secret. The value is encrypted on the server and never returned or shown to a model. */
export interface Secret {
  id: string;
  /** Used as {{secret:NAME}} in tool inputs. Letters, digits and underscores. */
  name: string;
  description: string;
  /** Stars that may use it; null means all. */
  starIds: string[] | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Push ---------------------------------------------------------------------

export interface PushSubscriptionInfo {
  id: string;
  /** A name for the device, e.g. "Pixel" or "Work laptop". */
  label: string;
  createdAt: string;
  lastSentAt: string | null;
}

// ---- Browser ------------------------------------------------------------------

/** A Star's tab in the shared real browser. */
export interface BrowserSession {
  starId: string;
  url: string;
  title: string;
  /** Changes whenever a new screenshot is ready at /browser/:starId/screenshot. */
  frameId: string | null;
  updatedAt: string;
}

export type ServerEvent =
  | LiveEvent
  | { type: 'provider.updated'; data: ModelProvider }
  | { type: 'provider.deleted'; data: { id: string } }
  | { type: 'browser.frame'; data: BrowserSession }
  | { type: 'star.activity'; data: { starId: string; activity: string | null; taskId: string | null; at: string } }
  | { type: 'skill.updated'; data: Skill }
  | { type: 'skill.deleted'; data: { id: string } }
  | { type: 'lesson.learned'; data: Lesson }
  | { type: 'lesson.undone'; data: Lesson }
  | { type: 'mcp.updated'; data: McpServer }
  | { type: 'mcp.deleted'; data: { id: string } }
  | { type: 'messaging.updated'; data: MessagingStatus }
  | { type: 'star.updated'; data: StarView }
  | { type: 'star.deleted'; data: { id: string } }
  | { type: 'constellation.message'; data: ConstellationMessage };
