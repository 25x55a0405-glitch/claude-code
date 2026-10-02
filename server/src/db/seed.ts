import type { Connection, Rule, Settings, Skill } from '../types.ts';

export const defaultSettings = (userName: string): Settings => ({
  userName,
  agentName: 'Sky',
  avatar: { character: 'cloud', color: 'sky' },
  tone: 'warm',
  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  autonomy: 'balanced',
  briefingTime: '08:00',
  quietHours: { enabled: true, start: '22:30', end: '07:00' },
  proactiveResearch: true,
  channels: { web: true, email: false, push: false, slack: false, telegram: false },
  learnFromCorrections: true,
  smallProviderIds: null,
  ntfyTopic: null,
  ntfyServer: '',
  guard: 'model',
  passwordFill: false,
});

/** Built-in safety rules. The ids are stable; the policy engine keys off them. */
export const builtInRules = (at: string): Rule[] => [
  { id: 'r_money', text: 'Always ask before spending money or moving funds', enabled: true, builtIn: true, createdAt: at },
  { id: 'r_pw', text: 'Never change passwords or security settings', enabled: true, builtIn: true, createdAt: at },
];

/** Skills every Star has. The ids are stable. */
export const builtInSkills = (at: string): Skill[] => [
  {
    id: 'k_forget', name: 'Forget something', source: 'builtIn', starId: null, uses: 0, lastUsedAt: null, createdAt: at, updatedAt: at,
    whenToUse: 'When the person asks you to forget something, or to stop remembering a topic.',
    steps: [
      '1. Call recall with the topic to see what you remember about it, with ids.',
      '2. Call forget_memories with the ids of every memory that is about that topic. Leave unrelated ones alone.',
      '3. If a skill is about the topic, tell the person; they can delete it on the Skills page.',
      '4. Tell the person in one sentence what you forgot. Don’t repeat the forgotten details.',
    ].join('\n'),
  },
];

/** Every provider the server knows, shown on the Connections screen even before they are connected. */
export const connectionCatalog: Omit<Connection, 'status' | 'lastSyncAt'>[] = [
  { id: 'web', provider: 'web', name: 'Web search', description: 'Search and read the web (Claude’s own web tools)', access: 'read' },
  { id: 'browser', provider: 'browser', name: 'Browser', description: 'A real browser your Stars drive: open sites, click and fill in forms. Sign-ins stick.', access: 'read_write' },
  { id: 'gmail', provider: 'gmail', name: 'Gmail', description: 'Read, draft and send email', access: 'read_write' },
  { id: 'calendar', provider: 'calendar', name: 'Google Calendar', description: 'See and schedule events', access: 'read_write' },
  { id: 'drive', provider: 'drive', name: 'Google Drive', description: 'Find and read documents', access: 'read' },
  { id: 'github', provider: 'github', name: 'GitHub', description: 'Watch repos, issues and pull requests', access: 'read' },
  { id: 'notion', provider: 'notion', name: 'Notion', description: 'Read and update pages and databases', access: 'read_write' },
  { id: 'slack', provider: 'slack', name: 'Slack', description: 'Post updates to Slack', access: 'read' },
  { id: 'telegram', provider: 'telegram', name: 'Telegram', description: 'Chat with Sky from your phone', access: 'read_write' },
];
