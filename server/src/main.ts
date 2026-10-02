import type { Brain } from './agent/brain.ts';
import { Runtime } from './agent/runtime.ts';
import { ScriptedBrain } from './agent/scripted.ts';
import { loadConfig, type Config } from './config.ts';
import { Providers } from './connections/providers.ts';
import { Db } from './db/db.ts';
import { EventBus } from './events.ts';
import { createHttpServer } from './http/server.ts';
import { Store } from './store.ts';
import { ModelRegistry } from './models/registry.ts';
import { ModelRouter } from './models/router.ts';
import { BrowserManager } from './browser/browser.ts';
import { Vault } from './vault.ts';
import { Push } from './push.ts';
import { Triggers } from './triggers.ts';
import { McpManager } from './mcp.ts';
import { Messaging } from './messaging.ts';
import { Templates } from './templates.ts';
import { StarMail } from './mail.ts';

export interface App {
  config: Config;
  store: Store;
  runtime: Runtime;
  providers: Providers;
  models: ModelRouter;
  browser: BrowserManager;
  vault: Vault;
  push: Push;
  triggers: Triggers;
  mcp: McpManager;
  messaging: Messaging;
  templates: Templates;
  mail: StarMail;
  /** Starts the clock, the messaging bridges, MCP servers and mail checks. */
  start(): void;
  server: ReturnType<typeof createHttpServer>;
  close(): Promise<void>;
}

/** Wires the pieces together. Tests call this with an in-memory database and the scripted brain. */
export function createApp(config: Config, brain?: Brain): App {
  const db = new Db(config.dbPath);
  const store = new Store(db, new EventBus(), config);
  const providers = new Providers(store, config);
  const models = new ModelRouter(new ModelRegistry(store, config), config);
  const browser = new BrowserManager(store, config);
  const vault = new Vault(store, config);
  // Through the providers' fetch, so tests can stand in for ntfy.
  const push = new Push(store, config, () => providers.fetch);
  const triggers = new Triggers(store, config, providers);
  const mcp = new McpManager(store, vault);
  const runtime = new Runtime(store, config, brain ?? (config.brain === 'scripted' ? new ScriptedBrain() : models), providers, browser, { vault, push, triggers, mcp });
  const messaging = new Messaging(store, config, providers, runtime, triggers);
  runtime.messaging = messaging;
  const mail = new StarMail(store, providers, runtime);
  triggers.onStarMail = () => mail.check();
  const templates = new Templates(store, providers);
  const server = createHttpServer(config, { store, runtime, providers, models, browser, vault, push, triggers, mcp, messaging, templates, mail });
  return {
    config, store, runtime, providers, models, browser, vault, push, triggers, mcp, messaging, templates, mail, server,
    start() {
      runtime.start();
      messaging.start();
      triggers.start();
      void mcp.start();
      void triggers.pollMail();
    },
    async close() {
      await messaging.stop();
      await triggers.stop();
      await mcp.stop();
      await runtime.stop();
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const app = createApp(config);
  app.start();
  app.server.listen(config.port, config.host, () => {
    const chain = app.models.chain().map((p) => `${p.name} (${p.model})`);
    const brain = app.runtime.brain.name === 'scripted'
      ? 'the scripted offline brain (add a model provider in the app, or set ANTHROPIC_API_KEY)'
      : `models: ${chain.join(' → ')}`;
    console.log(`Sky is up on http://${config.host}:${config.port}/api/v1 using ${brain}`);
    if (!config.password && config.host !== '127.0.0.1') console.warn('Warning: no SKY_PASSWORD set and listening beyond localhost.');
  });
  const shutdown = async () => {
    console.log('Shutting down…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
