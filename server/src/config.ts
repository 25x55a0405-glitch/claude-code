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
  const port = Number(env.PORT ?? env.SKYS_PORT ?? 8787);
  const dataDir = resolve(env.SKYS_DATA_DIR ?? 'data');
  const publicUrl = (env.SKYS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const webOrigin = env.SKYS_WEB_ORIGIN ?? null;
  const anthropicKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
  const brain = (env.SKYS_BRAIN as Config['brain']) ?? (anthropicKey ? 'claude' : 'scripted');
  const telegram = env.SKYS_TELEGRAM_BOT_TOKEN && env.SKYS_TELEGRAM_CHAT_ID
    ? { botToken: env.SKYS_TELEGRAM_BOT_TOKEN, chatId: env.SKYS_TELEGRAM_CHAT_ID }
    : undefined;
  return {
    port,
    host: env.SKYS_HOST ?? (env.SKYS_PASSWORD ? '0.0.0.0' : '127.0.0.1'),
    dataDir,
    dbPath: env.SKYS_DB ?? resolve(dataDir, 'skys.db'),
    publicUrl,
    webOrigin,
    webUrl: (env.SKYS_WEB_URL ?? webOrigin ?? publicUrl).replace(/\/$/, ''),
    webDist: resolve(env.SKYS_WEB_DIST ?? '../web/dist'),
    password: env.SKYS_PASSWORD || null,
    apiToken: env.SKYS_API_TOKEN || null,
    sessionSecret: env.SKYS_SESSION_SECRET || null,
    anthropicKey,
    model: env.SKYS_MODEL ?? 'claude-opus-5-5',
    effort: (env.SKYS_EFFORT as Config['effort']) ?? 'medium',
    fallbacks: env.SKYS_FALLBACKS !== '0',
    brain,
    userName: env.SKYS_USER_NAME ?? 'there',
    tickMs: Number(env.SKYS_TICK_MS ?? 15_000),
    researchEveryMs: Number(env.SKYS_RESEARCH_EVERY_MIN ?? 240) * 60_000,
    maxStepsPerRun: Number(env.SKYS_MAX_STEPS ?? 24),
    providers: {
      google: pair(env, 'GOOGLE'),
      github: pair(env, 'GITHUB'),
      notion: pair(env, 'NOTION'),
      slack: pair(env, 'SLACK'),
      githubToken: env.SKYS_GITHUB_TOKEN || undefined,
      telegram,
    },
    ...overrides,
  };
}
