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
  | { type: 'star.updated'; data: StarView }
  | { type: 'star.deleted'; data: { id: string } }
  | { type: 'constellation.message'; data: ConstellationMessage };
