import type {
  ActivityEvent,
  AgentStatus,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  Idea,
  Briefing,
  Connection,
  Conversation,
  CreateTaskInput,
  LiveEvent,
  MemoryItem,
  Message,
  Page,
  Rule,
  Settings,
  Task,
  TaskCommand,
  TaskDetail,
  TaskStatus,
  ConstellationMessage,
  StarInput,
  StarView,
} from './types';

/**
 * Everything the UI needs from the back end. HttpApi implements it over
 * the REST + SSE contract in docs/API.md; MockApi implements it in memory
 * so the UI can be developed and demoed without a server.
 */
export interface Session {
  signedIn: boolean;
  authRequired: boolean;
}

export interface SkyApi {
  getSession(): Promise<Session>;
  /** Rejects with the server's message when the password is wrong. */
  signIn(password: string): Promise<void>;
  signOut(): Promise<void>;

  getStatus(): Promise<AgentStatus>;
  setPaused(paused: boolean): Promise<AgentStatus>;
  getBriefing(): Promise<Briefing>;

  listStars(): Promise<StarView[]>;
  createStar(input: StarInput): Promise<StarView>;
  updateStar(id: string, patch: Partial<StarInput>): Promise<StarView>;
  /** Not allowed for the main Star. */
  deleteStar(id: string): Promise<void>;
  pauseStar(id: string, paused: boolean): Promise<StarView>;
  /** Messages between Stars, oldest first; with starId, only the ones that Star sent or received. */
  listConstellationMessages(starId?: string): Promise<ConstellationMessage[]>;

  listTasks(filter?: { status?: TaskStatus[]; starId?: string }): Promise<Task[]>;
  getTask(id: string): Promise<TaskDetail>;
  createTask(input: CreateTaskInput): Promise<Task>;
  commandTask(id: string, command: TaskCommand): Promise<Task>;

  listApprovals(status?: ApprovalStatus): Promise<Approval[]>;
  decideApproval(id: string, decision: ApprovalDecision): Promise<Approval>;

  listConversations(): Promise<Conversation[]>;
  /** A side chat with the given Star (the main Star when omitted). */
  createConversation(starId?: string): Promise<Conversation>;
  listMessages(conversationId: string): Promise<Message[]>;
  /** Returns the stored user message; the agent reply arrives as message.delta / message.done events. */
  sendMessage(conversationId: string, content: string): Promise<Message>;

  listMemory(): Promise<MemoryItem[]>;
  addMemory(input: Pick<MemoryItem, 'category' | 'content'>): Promise<MemoryItem>;
  updateMemory(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'pinned' | 'category'>>): Promise<MemoryItem>;
  deleteMemory(id: string): Promise<void>;

  listConnections(): Promise<Connection[]>;
  updateConnection(id: string, patch: { access?: Connection['access'] }): Promise<Connection>;
  /** Returns a URL to send the user to for OAuth, or null when connected directly. */
  connect(id: string): Promise<{ authorizeUrl: string | null; connection: Connection }>;
  disconnect(id: string): Promise<Connection>;

  /** With starId: what that Star is bound by, shared rules plus its own. */
  listRules(starId?: string): Promise<Rule[]>;
  /** With starId, the rule applies to that Star only. */
  addRule(text: string, starId?: string): Promise<Rule>;
  updateRule(id: string, patch: Partial<Pick<Rule, 'text' | 'enabled'>>): Promise<Rule>;
  deleteRule(id: string): Promise<void>;

  listIdeas(): Promise<Idea[]>;
  dismissIdea(id: string): Promise<void>;

  listActivity(cursor?: string | null): Promise<Page<ActivityEvent>>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  /** Subscribe to live events. All subscribers share one connection. Returns an unsubscribe function. */
  subscribe(handler: (event: LiveEvent) => void): () => void;
}
