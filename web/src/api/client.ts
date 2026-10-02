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
  BrowserInput,
  BrowserSession,
  BrowserState,
  ModelProvider,
  ProviderInput,
  ProviderPreset,
  ProviderTest,
  Lesson,
  PushSubscriptionInfo,
  PushTestResult,
  Secret,
  SecretInput,
  SecretList,
  Skill,
  SkillInput,
  McpInput,
  McpServer,
  MessagingApp,
  MessagingStatus,
  StarTemplate,
  TemplateEntry,
  TriggerEvent,
  TriggerInput,
  TriggerSetup,
  Recording,
  SaveRecordingInput,
  SavedLogin,
  SavedLoginInput,
  WorkspaceFile,
  WorkspaceStatus,
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

  /** In the global order, which is also the fallback order. */
  listProviders(): Promise<ModelProvider[]>;
  listProviderPresets(): Promise<ProviderPreset[]>;
  createProvider(input: ProviderInput): Promise<ModelProvider>;
  updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ModelProvider>;
  deleteProvider(id: string): Promise<void>;
  testProvider(id: string): Promise<ProviderTest>;
  setProviderOrder(ids: string[]): Promise<string[]>;

  getBrowser(): Promise<BrowserState>;
  /** An image URL for the latest frame of a Star's tab; frameId busts the cache. */
  browserFrameUrl(starId: string, frameId: string | null): string;
  browserInput(starId: string, input: BrowserInput): Promise<BrowserSession>;
  closeBrowserTab(starId: string): Promise<void>;
  /** The person drives the tab until they hand it back (30 minutes at most). */
  takeOverBrowser(starId: string, note?: string): Promise<BrowserSession>;
  /** A task waiting on the browser carries on, with the note. */
  handBackBrowser(starId: string, note?: string): Promise<BrowserSession>;

  /** Takes over the tab and records what the person does, to teach a skill. */
  startRecording(starId: string, input?: { title?: string; url?: string }): Promise<Recording>;
  /** Ends the recording and drafts the skill. */
  stopRecording(starId: string): Promise<Recording>;
  listRecordings(starId?: string): Promise<Recording[]>;
  getRecording(id: string): Promise<Recording>;
  deleteRecording(id: string): Promise<void>;
  saveRecordingAsSkill(id: string, input: SaveRecordingInput): Promise<{ recording: Recording; skill: Skill; task: Task | null }>;

  getWorkspace(): Promise<WorkspaceStatus>;
  listFiles(starId: string, path?: string, recursive?: boolean): Promise<{ files: WorkspaceFile[]; usage: number }>;
  /** Where to load or download a file from. */
  fileUrl(starId: string, path: string, download?: boolean): string;
  uploadFile(starId: string, path: string, file: Blob): Promise<WorkspaceFile>;
  deleteFile(starId: string, path: string): Promise<void>;

  listLogins(): Promise<{ enabled: boolean; logins: SavedLogin[] }>;
  createLogin(input: SavedLoginInput): Promise<SavedLogin>;
  updateLogin(id: string, patch: Partial<Omit<SavedLoginInput, 'origin'>>): Promise<SavedLogin>;
  deleteLogin(id: string): Promise<void>;

  /** With starId: the skills that Star can use (shared plus its own). */
  listSkills(starId?: string): Promise<Skill[]>;
  createSkill(input: SkillInput): Promise<Skill>;
  updateSkill(id: string, patch: Partial<SkillInput>): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;
  /** Newest first. */
  listLessons(starId?: string): Promise<Lesson[]>;
  undoLesson(id: string): Promise<Lesson>;

  listSecrets(starId?: string): Promise<SecretList>;
  createSecret(input: SecretInput): Promise<Secret>;
  /** By name or id. */
  updateSecret(name: string, patch: Partial<Omit<SecretInput, 'name'>>): Promise<Secret>;
  deleteSecret(name: string): Promise<void>;

  getPushKey(): Promise<{ publicKey: string }>;
  listPushSubscriptions(): Promise<PushSubscriptionInfo[]>;
  addPushSubscription(subscription: PushSubscriptionJSON, label?: string): Promise<PushSubscriptionInfo>;
  deletePushSubscription(id: string): Promise<void>;
  testPush(): Promise<PushTestResult>;

  /** Rejects with a 404 when the task has no trigger. */
  getTrigger(taskId: string): Promise<TriggerSetup>;
  /** null removes it. */
  setTrigger(taskId: string, trigger: TriggerInput | null): Promise<TriggerSetup | null>;
  rotateTrigger(taskId: string): Promise<TriggerSetup>;
  listTriggerEvents(taskId: string): Promise<TriggerEvent[]>;
  checkMail(): Promise<void>;

  listMessaging(): Promise<MessagingStatus[]>;
  connectTelegram(botToken: string): Promise<MessagingStatus>;
  connectSlack(botToken: string, appToken: string): Promise<MessagingStatus>;
  disconnectMessaging(app: MessagingApp): Promise<MessagingStatus>;
  /** The Slack app manifest, as text to paste. */
  slackManifest(): Promise<string>;

  listMcp(): Promise<McpServer[]>;
  createMcp(input: McpInput): Promise<McpServer>;
  updateMcp(id: string, patch: Partial<McpInput>): Promise<McpServer>;
  deleteMcp(id: string): Promise<void>;
  reconnectMcp(id: string): Promise<McpServer>;

  /** A group chat with two or more Stars. */
  createGroupChat(starIds: string[], title?: string): Promise<Conversation>;
  updateConversation(id: string, patch: { title?: string; starIds?: string[] }): Promise<Conversation>;

  listTemplates(): Promise<{ templates: TemplateEntry[]; galleryError: string | null }>;
  starTemplate(starId: string): Promise<StarTemplate>;
  importTemplate(from: { template: StarTemplate } | { id: string } | { url: string }): Promise<{ star: StarView; skipped: string[] }>;

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
