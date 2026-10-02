import type { Providers } from '../../connections/providers.ts';
import type { ClientToolSpec } from '../brain.ts';
import { appTools } from './apps.ts';
import { coreTools } from './core.ts';
import type { ToolDef } from './types.ts';

export const allTools: ToolDef[] = [...coreTools, ...appTools];
const byName = new Map(allTools.map((t) => [t.name, t]));

export const findTool = (name: string) => byName.get(name);

/** Tools on offer right now: core tools for this scope plus those whose app is connected. */
export function availableTools(scope: 'chat' | 'task', providers: Providers): ToolDef[] {
  return allTools.filter((t) => (!t.scope || t.scope === scope) && (!t.connection || providers.isUsable(t.connection)));
}

export const toSpec = (t: ToolDef): ClientToolSpec => ({ name: t.name, description: t.description, input_schema: t.input_schema });
