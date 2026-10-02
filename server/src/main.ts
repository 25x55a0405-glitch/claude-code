import { ClaudeBrain, type Brain } from './agent/brain.ts';
import { Runtime } from './agent/runtime.ts';
import { ScriptedBrain } from './agent/scripted.ts';
import { loadConfig, type Config } from './config.ts';
import { Providers } from './connections/providers.ts';
import { Db } from './db/db.ts';
import { EventBus } from './events.ts';
import { createHttpServer } from './http/server.ts';
import { Store } from './store.ts';

export interface App {
  config: Config;
  store: Store;
  runtime: Runtime;
  providers: Providers;
  server: ReturnType<typeof createHttpServer>;
  close(): Promise<void>;
}

/** Wires the pieces together. Tests call this with an in-memory database and the scripted brain. */
export function createApp(config: Config, brain?: Brain): App {
  const db = new Db(config.dbPath);
  const store = new Store(db, new EventBus(), config);
  const providers = new Providers(store, config);
  const runtime = new Runtime(store, config, brain ?? (config.brain === 'claude' ? new ClaudeBrain(config) : new ScriptedBrain()), providers);
  const server = createHttpServer(config, store, runtime, providers);
  return {
    config, store, runtime, providers, server,
    async close() {
      await runtime.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const app = createApp(config);
  app.runtime.start();
  app.server.listen(config.port, config.host, () => {
    const brain = app.runtime.brain.name === 'claude' ? `Claude (${config.model})` : 'scripted offline brain (set ANTHROPIC_API_KEY for the real one)';
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
