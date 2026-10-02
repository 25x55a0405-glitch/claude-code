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
  TaskDetail,
} from './types';

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const ahead = (min: number) => new Date(now + min * 60_000).toISOString();

export const seedSettings: Settings = {
  userName: 'd',
  agentName: 'Sky',
  avatar: { character: 'cloud', color: 'sky' },
  tone: 'warm',
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
  { id: 'web', provider: 'web', name: 'Web browser', description: 'Search and read the web in a sandboxed browser', status: 'connected', access: 'read', lastSyncAt: ago(1) },
  { id: 'notion', provider: 'notion', name: 'Notion', description: 'Read and update pages and databases', status: 'expired', access: 'read_write', lastSyncAt: ago(60 * 26) },
  { id: 'slack', provider: 'slack', name: 'Slack', description: 'Talk to Sky and post to channels', status: 'disconnected', access: 'read' },
  { id: 'drive', provider: 'drive', name: 'Google Drive', description: 'Find and read documents', status: 'disconnected', access: 'read' },
  { id: 'telegram', provider: 'telegram', name: 'Telegram', description: 'Chat with Sky from your phone', status: 'disconnected', access: 'read_write' },
];

export const seedTasks: TaskDetail[] = [
  {
    id: 't_inbox',
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
  { id: 'c_main', main: true, title: 'Sky', updatedAt: ago(1), preview: 'One thing needs you: Maya wants to move Friday.' },
  { id: 'c_trip', main: false, title: 'Lisbon trip', updatedAt: ago(60 * 30), preview: 'I’ll watch fares and ping you under $600.' },
  { id: 'c_gift', main: false, title: 'Gift for Sam', updatedAt: ago(60 * 24 * 3), preview: 'The pour-over kit arrives Thursday.' },
];

export const seedMessages: Message[] = [
  { id: 'msg1', conversationId: 'c_main', role: 'user', content: 'Can you book me a dentist cleaning at Smile Studio? After 4pm, next two weeks.', createdAt: ago(60 * 6), status: 'done' },
  { id: 'msg2', conversationId: 'c_main', role: 'agent', content: 'On it. I’ll check their booking page against your calendar and take the first slot that fits.', createdAt: ago(60 * 6 - 1), status: 'done' },
  { id: 'msg3', conversationId: 'c_main', role: 'agent', content: 'Booked. **Tuesday Oct 7 at 4:30pm** is on your calendar, with a reminder the day before.', createdAt: ago(60 * 5), status: 'done', cards: [{ kind: 'task', taskId: 't_dentist' }] },
  { id: 'msg4', conversationId: 'c_main', role: 'agent', proactive: true, content: 'Good morning, d. Quiet night: I cleared 31 emails and Lisbon fares dropped 4%. You have three meetings, the first at 10:30.', createdAt: ago(60 * 2), status: 'done' },
  { id: 'msg5', conversationId: 'c_main', role: 'agent', proactive: true, content: 'One thing needs you. Maya wants to move Friday’s review, and you’re free Thursday at 3. I drafted a reply:', createdAt: ago(2), status: 'done', cards: [{ kind: 'approval', approvalId: 'a_maya' }] },
  { id: 'msg6', conversationId: 'c_trip', role: 'user', content: 'Find me flights to Lisbon, Oct 18 to 25, under $600. Mornings, one stop max.', createdAt: ago(60 * 31), status: 'done' },
  { id: 'msg7', conversationId: 'c_trip', role: 'agent', content: 'Nothing under $600 yet. The best is $642 on TAP with one stop in Newark. I’ll keep watching and ping you the moment it dips.', createdAt: ago(60 * 30), status: 'done', cards: [{ kind: 'task', taskId: 't_flights' }] },
  { id: 'msg8', conversationId: 'c_gift', role: 'user', content: 'Sam’s birthday is next week. Something coffee related, around $80?', createdAt: ago(60 * 24 * 3 + 5), status: 'done' },
  { id: 'msg9', conversationId: 'c_gift', role: 'agent', content: 'Ordered the Fellow pour-over kit for $76. It arrives Thursday, gift wrapped.', createdAt: ago(60 * 24 * 3), status: 'done' },
];
