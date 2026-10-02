import type { Config } from '../config.ts';
import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import type { Brain } from './brain.ts';
import type { Policy } from './policy.ts';
import type { RuntimeHooks } from './tools/types.ts';
import type { BrowserManager } from '../browser/browser.ts';
import type { Vault } from '../vault.ts';
import type { Triggers } from '../triggers.ts';
import type { McpManager } from '../mcp.ts';
import type { Workspaces } from '../workspace.ts';
import type { Guard } from './guard.ts';

/** Everything the agent pieces share. */
export interface AgentDeps {
  store: Store;
  config: Config;
  brain: Brain;
  providers: Providers;
  policy: Policy;
  hooks: RuntimeHooks;
  browser?: BrowserManager;
  vault?: Vault;
  triggers?: Triggers;
  mcp?: McpManager;
  workspaces?: Workspaces;
  guard?: Guard;
}
