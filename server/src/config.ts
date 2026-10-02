import { resolve } from 'node:path';

/** Everything the server reads from the environment, in one place. */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Path to the SQLite file, or ":memory:". */
  dbPath: string;
  /** Public URL of this server, used for OAuth redirects. */
  publicUrl: string;
  /** Where the web UI lives, used for CORS and post-OAuth redirects. */
  webOrigin: string | null;
  webUrl: string;
  /** Built web UI to serve at "/", if present. */
  webDist: string;
  password: string | null;
  apiToken: string | null;
  sessionSecret: string | null;
  anthropicKey: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fallbacks: boolean;
  /** "claude" uses the Claude API; "scripted" is the offline brain used in tests and demos. */
  brain: 'claude' | 'scripted';
  userName: string;
  tickMs: number;
  researchEveryMs: number;
  maxStepsPerRun: number;
  providers: {
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
    notion?: { clientId: string; clientSecret: string };
    slack?: { clientId: string; clientSecret: string };
    githubToken?: string;
    telegram?: { botToken: string; chatId: string };
  };
}

const pair = (env: NodeJS.ProcessEnv, prefix: string) => {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  // SKY_* settings, still accepting the older SKYS_* names.
  const v = (name: string) => env[`SKY_${name}`] ?? env[`SKYS_${name}`];
  const port = Number(env.PORT ?? v('PORT') ?? 8787);
  const dataDir = resolve(v('DATA_DIR') ?? 'data');
  const publicUrl = (v('PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/$/, '');
  const webOrigin = v('WEB_ORIGIN') ?? null;
  const anthropicKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
  const brain = (v('BRAIN') as Config['brain']) ?? (anthropicKey ? 'claude' : 'scripted');
  const botToken = v('TELEGRAM_BOT_TOKEN');
  const chatId = v('TELEGRAM_CHAT_ID');
  const telegram = botToken && chatId ? { botToken, chatId } : undefined;
  return {
    port,
    host: v('HOST') ?? (v('PASSWORD') ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    dbPath: v('DB') ?? resolve(dataDir, 'sky.db'),
    publicUrl,
    webOrigin,
    webUrl: (v('WEB_URL') ?? webOrigin ?? publicUrl).replace(/\/$/, ''),
    webDist: resolve(v('WEB_DIST') ?? '../web/dist'),
    password: v('PASSWORD') || null,
    apiToken: v('API_TOKEN') || null,
    sessionSecret: v('SESSION_SECRET') || null,
    anthropicKey,
    model: v('MODEL') ?? 'claude-opus-5-5',
    effort: (v('EFFORT') as Config['effort']) ?? 'medium',
    fallbacks: v('FALLBACKS') !== '0',
    brain,
    userName: v('USER_NAME') ?? 'there',
    tickMs: Number(v('TICK_MS') ?? 15_000),
    researchEveryMs: Number(v('RESEARCH_EVERY_MIN') ?? 240) * 60_000,
    maxStepsPerRun: Number(v('MAX_STEPS') ?? 24),
    providers: {
      google: pair(env, 'GOOGLE'),
      github: pair(env, 'GITHUB'),
      notion: pair(env, 'NOTION'),
      slack: pair(env, 'SLACK'),
      githubToken: v('GITHUB_TOKEN') || undefined,
      telegram,
    },
    ...overrides,
  };
}
