import type {
  ActivityEvent,
  Approval,
  Briefing,
  Connection,
  Conversation,
  Idea,
  MemoryItem,
  Message,
  Rule,
  Settings,
  Star,
  ConstellationMessage,
  TaskDetail,
  BrowserSession,
  ModelProvider,
  ProviderPreset,
  Lesson,
  PushSubscriptionInfo,
  Secret,
  Skill,
  McpServer,
  MessagingStatus,
  TemplateEntry,
  TriggerEvent,
} from './types';

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();

export const seedSettings: Settings = {
  userName: 'd',
  agentName: 'Sky',
  avatar: { character: 'cloud', color: 'sky' },
  tone: 'warm',
  learnFromCorrections: true,
  smallProviderIds: null,
  ntfyTopic: null,
  ntfyServer: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  autonomy: 'balanced',
  briefingTime: '08:00',
  quietHours: { enabled: true, start: '22:30', end: '07:00' },
  proactiveResearch: true,
  channels: { web: true, email: true, push: true, slack: false, telegram: false },
};

export const seedConnections: Connection[] = [
  { id: 'gmail', provider: 'gmail', name: 'Gmail', description: 'Read, draft and send email', status: 'connected', access: 'read_write', lastSyncAt: ago(4) },
  { id: 'calendar', provider: 'calendar', name: 'Google Calendar', description: 'See and schedule events', status: 'connected', access: 'read_write', lastSyncAt: ago(4) },
  { id: 'github', provider: 'github', name: 'GitHub', description: 'Watch repos, issues and pull requests', status: 'connected', access: 'read', lastSyncAt: ago(12) },
  { id: 'web', provider: 'web', name: 'Web search', description: 'Search and read the web', status: 'connected', access: 'read', lastSyncAt: ago(1) },
  { id: 'browser', provider: 'browser', name: 'Browser', description: 'A real browser your Stars drive: open sites, click and fill in forms. Sign-ins stick.', status: 'connected', access: 'read_write', lastSyncAt: ago(1) },
  { id: 'notion', provider: 'notion', name: 'Notion', description: 'Read and update pages and databases', status: 'expired', access: 'read_write', lastSyncAt: ago(60 * 26) },
  { id: 'slack', provider: 'slack', name: 'Slack', description: 'Talk to Sky and post to channels', status: 'disconnected', access: 'read' },
  { id: 'drive', provider: 'drive', name: 'Google Drive', description: 'Find and read documents', status: 'disconnected', access: 'read' },
  { id: 'telegram', provider: 'telegram', name: 'Telegram', description: 'Chat with Sky from your phone', status: 'disconnected', access: 'read_write' },
];

export const seedTasks: TaskDetail[] = [
  {
    id: 't_bank',
    starId: 'star_post',
    title: 'File bank statements',
    description: 'When a statement email from my bank arrives, save the PDF to Drive and tell me the balance.',
    status: 'scheduled',
    kind: 'recurring',
    createdAt: ago(60 * 24 * 4),
    updatedAt: ago(60 * 26),
    lastRunAt: ago(60 * 26),
    connectionIds: ['gmail', 'drive'],
    lastOutcome: 'Saved the September statement to Drive',
    trigger: { kind: 'email', query: 'from:statements@mybank.com has:attachment', fired: 3, lastFiredAt: ago(60 * 26) },
    steps: [{ id: 'bk1', at: ago(60 * 26), kind: 'result', summary: 'Triggered: statement email. Saved the PDF to Drive/Finance' }],
  },
  {
    id: 't_ship',
    starId: 'star_sky',
    title: 'Summarise each push to main',
    description: 'When something is pushed to main on GitHub, tell me what changed in two lines.',
    status: 'scheduled',
    kind: 'recurring',
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(40),
    lastRunAt: ago(40),
    connectionIds: ['github'],
    lastOutcome: 'Push by d: new Models screen and live browser',
    trigger: { kind: 'github', events: ['push'], fired: 7, lastFiredAt: ago(40) },
    steps: [{ id: 'sh1', at: ago(40), kind: 'result', summary: 'Triggered: push to main. Summarised 2 commits' }],
  },
  {
    id: 't_inbox',
    starId: 'star_post',
    title: 'Keep my inbox at zero',
    description: 'Triage new email every hour. Archive noise, draft replies for anything that needs me, and flag what is urgent.',
    status: 'active',
    kind: 'recurring',
    schedule: 'Every hour, 7:00 to 22:00',
    progress: 0.6,
    createdAt: ago(60 * 24 * 6),
    updatedAt: ago(2),
    lastRunAt: ago(2),
    nextRunAt: ahead(58),
    connectionIds: ['gmail'],
    lastOutcome: 'Archived 14, drafted 2 replies, 1 needs your approval',
    steps: [
      { id: 's1', at: ago(9), kind: 'plan', summary: 'Check 23 new messages since the last pass' },
      { id: 's2', at: ago(8), kind: 'tool', summary: 'Fetched unread messages', connectionId: 'gmail', detail: 'gmail.list(q="is:unread newer_than:1h") → 23 messages' },
      { id: 's3', at: ago(6), kind: 'action', summary: 'Archived 14 newsletters and notifications', connectionId: 'gmail' },
      { id: 's4', at: ago(4), kind: 'thought', summary: 'Maya asked to move Friday review. Calendar shows Thursday 3pm is free.' },
      { id: 's5', at: ago(3), kind: 'action', summary: 'Drafted reply to Maya proposing Thursday 3pm', connectionId: 'gmail' },
      { id: 's6', at: ago(2), kind: 'approval', summary: 'Asked you before sending the reply to Maya' },
    ],
  },
  {
    id: 't_flights',
    starId: 'star_scout',
    requestedBy: { starId: 'star_sky' },
    title: 'Find flights to Lisbon under $600',
    description: 'Round trip, Oct 18 to Oct 25, morning departures, at most one stop. Tell me when something good shows up.',
    status: 'active',
    kind: 'watch',
    schedule: 'Checks every 3 hours',
    progress: 0.35,
    createdAt: ago(60 * 30),
    updatedAt: ago(1),
    lastRunAt: ago(1),
    nextRunAt: ahead(179),
    connectionIds: ['web'],
    lastOutcome: 'Best so far: $642 on TAP, 1 stop',
    steps: [
      { id: 'f1', at: ago(70), kind: 'plan', summary: 'Compare 4 airlines and 2 aggregators for Oct 18 to 25' },
      { id: 'f2', at: ago(40), kind: 'tool', summary: 'Searched Google Flights and Kayak', connectionId: 'web' },
      { id: 'f3', at: ago(20), kind: 'result', summary: 'Cheapest morning option is $642 on TAP with one stop in Newark' },
      { id: 'f4', at: ago(1), kind: 'thought', summary: 'Prices dipped 4% this week. Will keep checking before alerting.' },
    ],
  },
  {
    id: 't_brief',
    title: 'Morning briefing',
    description: 'Every weekday at 8:00, summarise my calendar, important email, and anything you found overnight.',
    status: 'scheduled',
    kind: 'recurring',
    schedule: 'Weekdays at 8:00',
    createdAt: ago(60 * 24 * 14),
    updatedAt: ago(60 * 2),
    lastRunAt: ago(60 * 2),
    nextRunAt: ahead(60 * 22),
    connectionIds: ['gmail', 'calendar', 'web'],
    lastOutcome: 'Delivered at 8:00 with 5 highlights',
    steps: [{ id: 'b1', at: ago(60 * 2), kind: 'result', summary: 'Delivered briefing with 5 highlights' }],
  },
  {
    id: 't_prs',
    title: 'Watch my GitHub pull requests',
    description: 'Tell me when a PR of mine gets a review or CI goes red.',
    status: 'active',
    kind: 'watch',
    schedule: 'Live',
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(15),
    connectionIds: ['github'],
    lastOutcome: 'No new reviews in the last hour',
    steps: [{ id: 'g1', at: ago(15), kind: 'tool', summary: 'Checked 3 open pull requests', connectionId: 'github' }],
  },
  {
    id: 't_notion',
    title: 'Sync reading list to Notion',
    description: 'Every Sunday, move links I saved this week into my Notion reading list with a one-line summary.',
    status: 'blocked',
    kind: 'recurring',
    schedule: 'Sundays at 18:00',
    createdAt: ago(60 * 24 * 20),
    updatedAt: ago(60 * 26),
    connectionIds: ['notion'],
    lastOutcome: 'Notion access expired. Reconnect to continue.',
    steps: [{ id: 'n1', at: ago(60 * 26), kind: 'error', summary: 'Notion returned 401: the connection has expired', connectionId: 'notion' }],
  },
  {
    id: 't_dentist',
    title: 'Book a dentist cleaning',
    description: 'Find a slot in the next two weeks, after 4pm, at Smile Studio.',
    status: 'done',
    kind: 'one_off',
    progress: 1,
    createdAt: ago(60 * 24 * 2),
    updatedAt: ago(60 * 5),
    connectionIds: ['web', 'calendar'],
    lastOutcome: 'Booked Tue Oct 7 at 4:30pm and added to your calendar',
    steps: [{ id: 'd1', at: ago(60 * 5), kind: 'result', summary: 'Booked Tue Oct 7 at 4:30pm' }],
  },
];

export const seedApprovals: Approval[] = [
  {
    id: 'a_maya',
    starId: 'star_post',
    taskId: 't_inbox',
    action: 'Send email',
    target: 'maya@studio.co',
    reason: 'Maya asked to move Friday’s design review. You are free Thursday at 3pm.',
    preview:
      'Hi Maya,\n\nFriday is tricky for me. Would Thursday at 3pm work instead? I’ve held the slot on my calendar.\n\nThanks,\nd',
    connectionId: 'gmail',
    risk: 'medium',
    status: 'pending',
    createdAt: ago(2),
    expiresAt: ahead(60 * 6),
  },
  {
    id: 'a_cal',
    starId: 'star_post',
    taskId: 't_inbox',
    action: 'Create calendar event',
    target: 'Design review · Thu 3:00 to 3:45pm',
    reason: 'Holds the time while Maya confirms.',
    preview: 'Design review with Maya\nThursday 3:00 to 3:45pm\nGoogle Meet link attached',
    connectionId: 'calendar',
    risk: 'low',
    status: 'pending',
    createdAt: ago(2),
  },
];

export const seedBriefing: Briefing = {
  id: 'br_today',
  generatedAt: ago(60 * 2),
  greeting: 'Good morning, d',
  summary:
    'Quiet night. I cleared 31 emails, one person needs an answer from you, and Lisbon flights are getting cheaper. You have 3 meetings today, the first at 10:30.',
  highlights: [
    { id: 'h1', kind: 'needs_you', title: 'Maya wants to move Friday’s review', detail: 'I drafted a reply proposing Thursday 3pm.', approvalId: 'a_maya' },
    { id: 'h2', kind: 'done', title: 'Dentist booked', detail: 'Tue Oct 7 at 4:30pm, already on your calendar.', taskId: 't_dentist' },
    { id: 'h3', kind: 'found', title: 'Lisbon fares dropped 4%', detail: 'Best is $642 on TAP. Still watching for under $600.', taskId: 't_flights' },
    { id: 'h4', kind: 'warning', title: 'Notion disconnected', detail: 'Your reading list sync is paused until you reconnect.', taskId: 't_notion' },
    { id: 'h5', kind: 'upcoming', title: '10:30 Standup, 13:00 Lunch with Sam, 16:00 1:1', detail: 'Sam mentioned the new place on Rua Augusta.' },
  ],
};

export const seedMemory: MemoryItem[] = [
  { id: 'm_sign', category: 'style', content: 'Sign emails with just “d”.', source: 'Learned from a correction', createdAt: ago(1.4), pinned: false },
  { id: 'm1', category: 'preference', content: 'Prefers morning flights and aisle seats', source: 'Chat on Sep 28', createdAt: ago(60 * 24 * 4), pinned: true },
  { id: 'm2', category: 'style', content: 'Writes short emails, signs off with just “d”', source: 'Learned from Gmail', createdAt: ago(60 * 24 * 6), pinned: false },
  { id: 'm3', category: 'person', content: 'Maya is the design lead at Studio. Reviews are usually Fridays.', source: 'Learned from Gmail', createdAt: ago(60 * 24 * 5), pinned: false },
  { id: 'm4', category: 'goal', content: 'Building Sky, a personal always-on agent', source: 'Chat on Oct 2', createdAt: ago(60), pinned: true },
  { id: 'm5', category: 'fact', content: 'Dentist is Smile Studio on 5th Street', source: 'Booking on Sep 30', createdAt: ago(60 * 5), pinned: false },
  { id: 'm6', category: 'preference', content: 'No meetings before 10am', source: 'Chat on Sep 20', createdAt: ago(60 * 24 * 12), pinned: false },
  { id: 'm7', category: 'person', content: 'Sam is a close friend. Lunch most Thursdays.', source: 'Learned from Calendar', createdAt: ago(60 * 24 * 9), pinned: false },
];

export const seedRules: Rule[] = [
  { id: 'r_money', text: 'Always ask before spending money or moving funds', enabled: true, builtIn: true, createdAt: ago(60 * 24 * 30) },
  { id: 'r_pw', text: 'Never change passwords or security settings', enabled: true, builtIn: true, createdAt: ago(60 * 24 * 30) },
  { id: 'r_send', text: 'Ask before sending messages to people I have not emailed before', enabled: true, builtIn: false, createdAt: ago(60 * 24 * 10) },
  { id: 'r_quiet', text: 'Don’t notify me during quiet hours unless it is urgent', enabled: true, builtIn: false, createdAt: ago(60 * 24 * 10) },
  { id: 'r_news', text: 'Archive newsletters without asking', enabled: true, builtIn: false, createdAt: ago(60 * 24 * 6) },
  { id: 'r_cal', text: 'Decline meeting invites before 10am politely', enabled: false, builtIn: false, createdAt: ago(60 * 24 * 3) },
  { id: 'r_scout', text: 'Only look at refundable fares', enabled: true, builtIn: false, createdAt: ago(60 * 24 * 2), starId: 'star_scout' },
];

export const seedActivity: ActivityEvent[] = [
  { id: 'e1', at: ago(1), kind: 'research', summary: 'Checked Lisbon fares across 6 sites', taskId: 't_flights' },
  { id: 'e2', at: ago(2), kind: 'approval_requested', summary: 'Asked to send a reply to Maya', taskId: 't_inbox' },
  { id: 'e3', at: ago(6), kind: 'task_started', summary: 'Started hourly inbox pass', taskId: 't_inbox' },
  { id: 'e4', at: ago(15), kind: 'research', summary: 'Checked 3 GitHub pull requests', taskId: 't_prs' },
  { id: 'e5', at: ago(60), kind: 'memory_learned', summary: 'Learned: you are building Sky' },
  { id: 'e6', at: ago(120), kind: 'task_completed', summary: 'Delivered your morning briefing', taskId: 't_brief' },
  { id: 'e7', at: ago(300), kind: 'task_completed', summary: 'Booked dentist for Tue Oct 7', taskId: 't_dentist' },
  { id: 'e8', at: ago(60 * 26), kind: 'task_failed', summary: 'Notion sync failed: access expired', taskId: 't_notion' },
];

export const seedIdeas: Idea[] = [
  { id: 'i1', kind: 'suggestion', title: 'Plan your Lisbon week', detail: 'You have flights in view. I can draft a day-by-day plan around Alfama and Príncipe Real.', prompt: 'Plan my week in Lisbon, Oct 18 to 25. Keep mornings slow.', createdAt: ago(40) },
  { id: 'i2', kind: 'tip', title: 'Unsubscribe from 9 newsletters', detail: 'You archive them every time without opening. I can unsubscribe for you.', prompt: 'Unsubscribe me from the newsletters I always archive.', createdAt: ago(60 * 3) },
  { id: 'i3', kind: 'plan_update', title: 'Move Friday reviews to Thursdays', detail: 'Maya has asked to move three of the last four. A standing Thursday slot might stick.', prompt: 'Propose a standing Thursday 3pm design review with Maya.', createdAt: ago(60 * 5) },
  { id: 'i4', kind: 'suggestion', title: 'Weekly “what I shipped” note', detail: 'Every Friday I could summarise your merged PRs and finished tasks.', prompt: 'Every Friday at 5pm, summarise what I shipped this week.', createdAt: ago(60 * 20) },
];

export const seedConversations: Conversation[] = [
  { id: 'c_main', main: true, title: 'Sky', updatedAt: ago(2), preview: 'One thing needs you: Maya wants to move Friday.', starId: 'star_sky' },
  { id: 'c_scout', main: false, title: 'Scout', updatedAt: ago(60 * 2), preview: 'Lisbon fares dropped 4%.', starId: 'star_scout' },
  { id: 'c_post', main: false, title: 'Post', updatedAt: ago(2), preview: 'I drafted a reply to Maya.', starId: 'star_post' },
  { id: 'c_trip', main: false, title: 'Lisbon trip', updatedAt: ago(60 * 30), preview: 'I’ll watch fares and ping you under $600.', starId: 'star_sky' },
  { id: 'c_group', main: false, title: 'Lisbon planning', updatedAt: ago(20), preview: 'Scout: Alfama is quieter at night.', starIds: ['star_sky', 'star_scout', 'star_post'] },
  { id: 'c_gift', main: false, title: 'Gift for Sam', updatedAt: ago(60 * 24 * 3), preview: 'The pour-over kit arrives Thursday.', starId: 'star_sky' },
];

export const seedMessages: Message[] = [
  { id: 'msg1', conversationId: 'c_main', role: 'user', content: 'Can you book me a dentist cleaning at Smile Studio? After 4pm, next two weeks.', createdAt: ago(60 * 6), status: 'done' },
  { id: 'msg2', conversationId: 'c_main', role: 'agent', content: 'On it. I’ll check their booking page against your calendar and take the first slot that fits.', createdAt: ago(60 * 6 - 1), status: 'done' },
  { id: 'msg3', conversationId: 'c_main', role: 'agent', content: 'Booked. **Tuesday Oct 7 at 4:30pm** is on your calendar, with a reminder the day before.', createdAt: ago(60 * 5), status: 'done', cards: [{ kind: 'task', taskId: 't_dentist' }] },
  { id: 'msg4', conversationId: 'c_main', role: 'agent', proactive: true, content: 'Good morning, d. Quiet night: I cleared 31 emails and Lisbon fares dropped 4%. You have three meetings, the first at 10:30.', createdAt: ago(60 * 2), status: 'done' },
  { id: 'msg5', conversationId: 'c_main', role: 'agent', proactive: true, content: 'One thing needs you. Maya wants to move Friday’s review. Post drafted a reply and it’s waiting for your OK in **Post’s chat**.', createdAt: ago(2), status: 'done' },
  { id: 'msg6', conversationId: 'c_trip', role: 'user', content: 'Find me flights to Lisbon, Oct 18 to 25, under $600. Mornings, one stop max.', createdAt: ago(60 * 31), status: 'done' },
  { id: 'msg7', conversationId: 'c_trip', role: 'agent', content: 'Nothing under $600 yet. The best is $642 on TAP with one stop in Newark. I’ll keep watching and ping you the moment it dips.', createdAt: ago(60 * 30), status: 'done', cards: [{ kind: 'task', taskId: 't_flights' }] },
  { id: 'msg8', conversationId: 'c_gift', role: 'user', content: 'Sam’s birthday is next week. Something coffee related, around $80?', createdAt: ago(60 * 24 * 3 + 5), status: 'done' },
  { id: 'msg9', conversationId: 'c_gift', role: 'agent', content: 'Ordered the Fellow pour-over kit for $76. It arrives Thursday, gift wrapped.', createdAt: ago(60 * 24 * 3), status: 'done' },
  { id: 'msg10', conversationId: 'c_scout', role: 'agent', starId: 'star_scout', content: 'Hi, I’m Scout. Sky passed me your Lisbon trip, so I’m watching fares and reading up on neighbourhoods.', createdAt: ago(60 * 30), status: 'done', cards: [{ kind: 'task', taskId: 't_flights' }] },
  { id: 'msg11', conversationId: 'c_scout', role: 'agent', starId: 'star_scout', proactive: true, content: 'Fares dropped 4%. The best is **$642 on TAP**, still above your $600 limit. I told Sky and I’ll keep watching.', createdAt: ago(60 * 2), status: 'done' },
  { id: 'msg12', conversationId: 'c_post', role: 'agent', starId: 'star_post', proactive: true, content: 'Inbox is at zero again. I archived 14, drafted 2 replies, and asked Sky about Maya’s request to move Friday.', createdAt: ago(9), status: 'done', cards: [{ kind: 'task', taskId: 't_inbox' }] },
  { id: 'msg13', conversationId: 'c_post', role: 'agent', starId: 'star_post', proactive: true, content: 'Maya wants to move Friday’s review. Sky checked and you’re free Thursday at 3, so I drafted a reply:', createdAt: ago(2), status: 'done', cards: [{ kind: 'approval', approvalId: 'a_maya' }, { kind: 'approval', approvalId: 'a_cal' }] },
  { id: 'msg_g1', conversationId: 'c_group', role: 'user', content: '@Scout where should we stay in Lisbon? @Post can you check if Maya replied about dates?', createdAt: ago(22), status: 'done' },
  { id: 'msg_g2', conversationId: 'c_group', role: 'agent', starId: 'star_scout', content: 'Alfama is quieter at night and close to the river. Príncipe Real has better cafés. I’d pick **Alfama** for a week.', createdAt: ago(21), status: 'done' },
  { id: 'msg_g3', conversationId: 'c_group', role: 'agent', starId: 'star_post', content: 'Maya hasn’t replied yet. I’ll tell you as soon as she does.', createdAt: ago(20), status: 'done' },
  { id: 'msg_tg', conversationId: 'c_scout', role: 'user', via: 'telegram', content: 'Any cheaper flights today?', createdAt: ago(50), status: 'done' },
  { id: 'msg14', conversationId: 'c_post', role: 'user', content: 'Actually, sign my emails just “d”, not “Best, d”.', createdAt: ago(1.5), status: 'done' },
  { id: 'msg15', conversationId: 'c_post', role: 'agent', starId: 'star_post', content: 'Got it. I’ll remember: sign emails with just “d”.', createdAt: ago(1.4), status: 'done', lessonId: 'l_sign' },
];

export const seedStars: Star[] = [
  {
    id: 'star_sky', name: 'Sky', role: 'Your main Star. Talks with you and keeps everything moving',
    instructions: 'Be my first point of contact. Pass work to the Star best suited for it and keep me posted.',
    avatar: { character: 'cloud', color: 'sky' }, main: true, autonomy: null, connectionIds: null, paused: false,
    personality: 'Calm, warm and a little dry. Notices the small things.', replyStyle: 'Short. Lead with the answer, then one line of why. No emoji.', notify: { whenDone: false, whenNeedsYou: true },
    conversationId: 'c_main', createdAt: ago(60 * 24 * 7), updatedAt: ago(60 * 24 * 7),
  },
  {
    id: 'star_scout', name: 'Scout', role: 'Researches trips, prices and places',
    instructions: 'Compare at least three sources. Never book or pay; bring me the options.',
    avatar: { character: 'dot', color: 'mint' }, main: false, autonomy: 'ask', connectionIds: ['web', 'browser', 'calendar'], paused: false, providerIds: ['p_groq', 'p_openrouter'],
    personality: 'Curious and thorough. Loves a good deal.', replyStyle: 'Bullet points with prices and links. Best option first.', notify: { whenDone: true, whenNeedsYou: true },
    conversationId: 'c_scout', createdAt: ago(60 * 24 * 2), updatedAt: ago(60 * 24 * 2),
  },
  {
    id: 'star_post', name: 'Post', role: 'Looks after your inbox and replies',
    instructions: 'Keep my inbox at zero. Draft replies in my voice and ask before sending anything.',
    avatar: { character: 'drop', color: 'peach' }, main: false, autonomy: null, connectionIds: ['gmail'], paused: false,
    personality: '', replyStyle: 'Write like d: friendly, brief, no exclamation marks.', notify: { whenDone: false, whenNeedsYou: true },
    conversationId: 'c_post', createdAt: ago(60 * 24 * 6), updatedAt: ago(60 * 24 * 6),
  },
];

export const seedConstellation: ConstellationMessage[] = [
  { id: 'cm1', fromStarId: 'star_sky', toStarId: 'star_scout', kind: 'handoff', content: 'Find flights to Lisbon, Oct 18 to 25, under $600. Mornings, one stop max.', taskId: 't_flights', createdAt: ago(60 * 31 - 1), read: true },
  { id: 'cm2', fromStarId: 'star_scout', toStarId: 'star_sky', kind: 'message', content: 'Fares dropped 4%. Best is $642 on TAP. Still watching for under $600.', taskId: 't_flights', createdAt: ago(60 * 2 + 1), read: true },
  { id: 'cm3', fromStarId: 'star_post', toStarId: 'star_sky', kind: 'request', content: 'Maya wants to move Friday’s review. Is d free Thursday at 3?', createdAt: ago(10), read: true },
  { id: 'cm4', fromStarId: 'star_sky', toStarId: 'star_post', kind: 'reply', content: 'Yes, Thursday 3pm is free. I’ll ask d before anything goes out.', createdAt: ago(3), read: true },
];

export const seedProviders: ModelProvider[] = [
  {
    id: 'p_builtin', name: 'Claude (server key)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', enabled: true,
    hasKey: true, keyHint: null, builtIn: true,
    health: { state: 'ok', lastOkAt: ago(1), lastError: null, lastErrorAt: null, cooldownUntil: null, failures: 0, latencyMs: 1840 },
    createdAt: ago(60 * 24 * 7), updatedAt: ago(1),
  },
  {
    id: 'p_openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', enabled: true,
    hasKey: true, keyHint: '9f2c', builtIn: false,
    health: { state: 'cooling', lastOkAt: ago(40), lastError: '429 Rate limit exceeded: free-models-per-min', lastErrorAt: ago(1), cooldownUntil: ahead(4), failures: 2, latencyMs: 2310 },
    createdAt: ago(60 * 24 * 3), updatedAt: ago(1),
  },
  {
    id: 'p_groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', enabled: true,
    hasKey: true, keyHint: 'a71e', builtIn: false,
    health: { state: 'ok', lastOkAt: ago(12), lastError: null, lastErrorAt: null, cooldownUntil: null, failures: 0, latencyMs: 420 },
    createdAt: ago(60 * 24 * 3), updatedAt: ago(12),
  },
  {
    id: 'p_ollama', name: 'Ollama (this computer)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', enabled: false,
    hasKey: false, keyHint: null, builtIn: false,
    health: { state: 'unknown', lastOkAt: null, lastError: null, lastErrorAt: null, cooldownUntil: null, failures: 0, latencyMs: null },
    createdAt: ago(60 * 24), updatedAt: ago(60 * 24),
  },
];

export const seedPresets: ProviderPreset[] = [
  { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', exampleModel: 'claude-opus-5-5', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Claude with thinking, web search and caching.' },
  { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', exampleModel: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true, keyUrl: 'https://openrouter.ai/keys', note: 'Hundreds of models; ids ending in :free cost nothing, with daily limits.' },
  { name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', exampleModel: 'llama-3.3-70b-versatile', needsKey: true, keyUrl: 'https://console.groq.com/keys', note: 'Very fast; free tier with per-minute limits.' },
  { name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', exampleModel: 'gemini-2.5-flash', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier through Google AI Studio.' },
  { name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', exampleModel: 'mistral-small-latest', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', note: 'Free experiment plan.' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-4.1-mini', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', note: '' },
  { name: 'Ollama (this computer)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', exampleModel: 'llama3.1', needsKey: false, keyUrl: null, note: 'Free and private; runs models on your own machine.' },
];

export const seedBrowser: BrowserSession[] = [
  { starId: 'star_scout', url: 'https://www.kayak.com/flights/JFK-LIS/2026-10-18/2026-10-25', title: 'New York to Lisbon, Oct 18 to 25 · KAYAK', frameId: 'f1', updatedAt: ago(1) },
];

export const seedSkills: Skill[] = [
  { id: 'sk_forget', name: 'Forget something', whenToUse: 'When you ask a Star to forget something it knows about you', steps: '1. Recall the memories that match, with their ids.\n2. Show you what will go.\n3. Call forget_memories with those ids.', starId: null, source: 'builtIn', uses: 2, lastUsedAt: ago(60 * 24 * 2), createdAt: ago(60 * 24 * 7), updatedAt: ago(60 * 24 * 7) },
  { id: 'sk_fares', name: 'Compare flight prices', whenToUse: 'Any request to find or watch flights', steps: '1. Search Kayak and Skyscanner with the same dates.\n2. Check the airline’s own site for the cheapest two.\n3. Report the best three with stops, times and price.\n- Lesson: d prefers morning departures, so list those first.', starId: 'star_scout', source: 'star', uses: 14, lastUsedAt: ago(9), createdAt: ago(60 * 30), updatedAt: ago(60 * 4) },
  { id: 'sk_reply', name: 'Draft a reply in d’s voice', whenToUse: 'Writing any email reply for d', steps: '1. Read the whole thread.\n2. Answer the question in the first line.\n3. Keep it under five lines and sign it “d”.', starId: 'star_post', source: 'you', uses: 6, lastUsedAt: ago(2), createdAt: ago(60 * 24 * 5), updatedAt: ago(60 * 24) },
  { id: 'sk_weekly', name: 'Weekly review', whenToUse: 'Sunday evening, or when d asks how the week went', steps: '1. List what got done and what slipped.\n2. Name the three things that matter next week.\n3. Ask one question if anything is unclear.', starId: null, source: 'you', uses: 1, lastUsedAt: ago(60 * 24 * 4), createdAt: ago(60 * 24 * 6), updatedAt: ago(60 * 24 * 6) },
];

export const seedLessons: Lesson[] = [
  { id: 'l_sign', starId: 'star_post', lesson: 'Sign emails with just “d”.', trigger: 'chat', memoryId: 'm_sign', undone: false, createdAt: ago(1.4) },
  { id: 'l_morning', starId: 'star_scout', lesson: 'd prefers morning departures, so list those first.', trigger: 'declined', skillId: 'sk_fares', taskId: 't_flights', undone: false, createdAt: ago(60 * 4) },
];

export const seedSecrets: Secret[] = [
  { id: 'sec_1', name: 'AIRLINE_LOYALTY', description: 'TAP Miles&Go number', starIds: ['star_scout'], lastUsedAt: ago(60 * 3), createdAt: ago(60 * 24 * 2), updatedAt: ago(60 * 24 * 2) },
  { id: 'sec_2', name: 'NOTION_TOKEN', description: 'For the reading list', starIds: null, lastUsedAt: null, createdAt: ago(60 * 24 * 5), updatedAt: ago(60 * 24 * 5) },
];

export const seedPushSubs: PushSubscriptionInfo[] = [
  { id: 'ps_1', label: 'Safari on iPhone', createdAt: ago(60 * 24 * 3), lastSentAt: ago(2) },
];

export const seedTriggerEvents: TriggerEvent[] = [
  { id: 'ev1', taskId: 't_ship', source: 'github', summary: 'push to main by d (1 commit)', content: '{"ref":"refs/heads/main"}', at: ago(1) },
];

export const seedMessaging: MessagingStatus[] = [
  { app: 'telegram', state: 'on', pairCode: null, pairLink: null, botName: 'my_sky_bot', error: null },
  { app: 'slack', state: 'off', pairCode: null, pairLink: null, botName: null, error: null },
];

export const seedMcp: McpServer[] = [
  {
    id: 'mcp_fs', name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/d/notes'], url: null,
    envKeys: [], headerKeys: [], enabled: true, toolEffects: {}, status: 'ready', error: null,
    tools: [
      { name: 'read_file', toolName: 'mcp_files_read_file', description: 'Read a file', effect: 'read' },
      { name: 'list_directory', toolName: 'mcp_files_list_directory', description: 'List a folder', effect: 'read' },
      { name: 'write_file', toolName: 'mcp_files_write_file', description: 'Create or overwrite a file', effect: 'write' },
    ],
    createdAt: ago(60 * 24 * 3), updatedAt: ago(60 * 24 * 3),
  },
  {
    id: 'mcp_linear', name: 'linear', transport: 'http', command: null, args: [], url: 'https://mcp.linear.app/mcp',
    envKeys: [], headerKeys: ['Authorization'], enabled: true, toolEffects: { create_issue: 'send' }, status: 'error', error: '401 Unauthorized: check the Authorization header',
    tools: [],
    createdAt: ago(60 * 24), updatedAt: ago(60),
  },
];

const tpl = (name: string, role: string, description: string, character: 'cloud' | 'dot' | 'drop', color: 'sky' | 'peach' | 'mint' | 'lilac' | 'sun', apps: string[] | null, skills: { name: string; whenToUse: string; steps: string }[], rules: string[]) => ({
  format: 'sky.star' as const, version: 1 as const, name, role, description, instructions: '', personality: '', replyStyle: '', avatar: { character, color }, autonomy: null, apps, skills, rules,
});

export const seedTemplates: TemplateEntry[] = [
  { id: 'builtin:scout', source: 'builtIn', template: tpl('Scout', 'Researches trips, prices and places', 'Compares at least three sources and brings you options.', 'dot', 'mint', ['web', 'browser'], [{ name: 'Compare prices', whenToUse: 'Finding the best price', steps: '1. Check three sites.\n2. Report the best three.' }], ['Never book or pay']) },
  { id: 'builtin:inbox', source: 'builtIn', template: tpl('Inbox', 'Looks after your inbox and replies', 'Archives the noise and drafts replies in your voice.', 'drop', 'peach', ['gmail'], [], ['Ask before sending anything']) },
  { id: 'builtin:builder', source: 'builtIn', template: tpl('Builder', 'Watches your repos, reviews and builds', 'Tells you when a review or a failing build needs you.', 'dot', 'sun', ['github'], [{ name: 'Summarise a PR', whenToUse: 'A pull request needs a quick read', steps: '1. Read the diff.\n2. Two lines on what changed and any risk.' }], []) },
  { id: 'gallery:chef', source: 'gallery', url: 'https://raw.githubusercontent.com/sky-stars/gallery/main/chef.json', template: tpl('Chef', 'Plans meals and makes the shopping list', 'Plans a week of dinners around what you like.', 'cloud', 'sun', null, [], []) },
  { id: 'gallery:coach', source: 'gallery', url: 'https://raw.githubusercontent.com/sky-stars/gallery/main/coach.json', template: tpl('Coach', 'Keeps you on track with workouts', 'Gentle nudges and a weekly check-in.', 'drop', 'lilac', ['calendar'], [], []) },
];
