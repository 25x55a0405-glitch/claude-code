import type { Providers } from '../../connections/providers.ts';
import type { Star } from '../../types.ts';
import type { ClientToolSpec } from '../brain.ts';
import { constellationTools } from './constellation.ts';
import { browserTools } from './browser.ts';
import { skillTools } from './skills.ts';
import { appTools } from './apps.ts';
import { coreTools } from './core.ts';
import { workspaceTools } from './workspace.ts';
import { computerTools } from './computer.ts';
import type { ToolDef } from './types.ts';

export const allTools: ToolDef[] = [...coreTools, ...skillTools, ...constellationTools, ...workspaceTools, ...computerTools, ...browserTools, ...appTools];
const byName = new Map(allTools.map((t) => [t.name, t]));

export const findTool = (name: string) => byName.get(name);

/**
 * Tools on offer right now: core tools for this scope, plus those whose app is
 * connected and, for a Star limited to some apps, allowed to it.
 */
export function availableTools(scope: 'chat' | 'task', providers: Providers, star?: Star): ToolDef[] {
  return allTools.filter((t) => (!t.scope || t.scope === scope) && (!t.when || t.when(providers.store))
    && (!t.connection || (providers.isUsable(t.connection) && (!star?.connectionIds || star.connectionIds.includes(t.connection)))));
}

export const toSpec = (t: ToolDef): ClientToolSpec => ({ name: t.name, description: t.description, input_schema: t.input_schema });
