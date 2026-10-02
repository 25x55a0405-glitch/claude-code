import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { StepKind } from '../types.ts';
import { firstLine, truncate } from '../util.ts';
import type { AgentDeps } from './deps.ts';
import type { ToolContext, ToolDef } from './tools/types.ts';

const STEP_KIND: Record<ToolDef['effect'], StepKind> = { internal: 'note', read: 'tool', write: 'action', send: 'action', delete: 'action', spend: 'action' };
const QUIET_STEPS = new Set(['finish_task']);

/**
 * Runs one tool call and returns the tool_result for the model. Inside a
 * task it also writes the step to the timeline, and links the task to the
 * connection it used so an expired token can block it.
 */
export async function executeTool(deps: AgentDeps, tool: ToolDef, input: any, ctx: ToolContext, toolUseId: string): Promise<BetaToolResultBlockParam> {
  const task = ctx.task;
  try {
    const out = await tool.run(input, ctx);
    const res = typeof out === 'string' ? { content: out } : out;
    if (task && !QUIET_STEPS.has(tool.name)) {
      const summary = res.summary ?? tool.label(input);
      const kind = tool.name === 'update_progress' ? 'note' : STEP_KIND[tool.effectFor?.(input) ?? tool.effect];
      const detail = res.content.length > 0 && res.content !== 'Noted.' && res.content !== summary ? truncate(res.content, 4000) : undefined;
      deps.store.addStep(task.id, { kind, summary: firstLine(summary, 160), ...(detail ? { detail } : {}), ...(tool.connection ? { connectionId: tool.connection } : {}) });
      deps.store.setActivity(firstLine(summary, 80), task.id);
      if (tool.connection) linkConnection(deps, task.id, tool.connection);
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: res.content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (task) {
      deps.store.addStep(task.id, { kind: 'error', summary: firstLine(`${tool.label(input)} failed: ${message}`, 160), detail: message, ...(tool.connection ? { connectionId: tool.connection } : {}) });
      if (tool.connection) linkConnection(deps, task.id, tool.connection);
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: `Error: ${message}`, is_error: true };
  }
}

function linkConnection(deps: AgentDeps, taskId: string, connectionId: string) {
  const t = deps.store.findTask(taskId);
  if (t && !t.connectionIds.includes(connectionId)) deps.store.patchTask(taskId, { connectionIds: [...t.connectionIds, connectionId] });
}

export const errorResult = (toolUseId: string, message: string): BetaToolResultBlockParam =>
  ({ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true });
