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
  }
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
  | { type: 'star.updated'; data: StarView }
  | { type: 'star.deleted'; data: { id: string } }
  | { type: 'constellation.message'; data: ConstellationMessage };
