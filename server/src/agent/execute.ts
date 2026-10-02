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
  const redact = (text: string) => deps.vault?.redact(text) ?? text;
  // Link first, so a token that turns out to be expired blocks this task too.
  if (task && tool.connection) linkConnection(deps, task.id, tool.connection);
  // The live status phrase under the Star's avatar.
  const doing = doingPhrase(tool.name);
  if (task) deps.store.setActivity(doing, task.id);
  else deps.store.setStarPhrase(ctx.star.id, doing);
  try {
    // Secrets go in at the last moment; the model, steps and logs only ever see {{secret:NAME}}.
    // Only tools that reach outside Sky, inside a task (where the policy asks first), get a secret:
    // anywhere else it would end up in memory, a message or a chat the model can read.
    const refs = deps.vault?.refs(input) ?? [];
    if (refs.length && (!task || (tool.effectFor?.(input, { starId: ctx.star.id, browser: ctx.browser, workspaces: ctx.workspaces, vault: ctx.vault, companion: ctx.companion }) ?? tool.effect) === 'internal')) {
      throw new Error(`Secrets (${refs.join(', ')}) can only be used by a task's tools that act outside Sky, like sending or browsing, never in chat, memory, skills or messages.`);
    }
    const filled = refs.length ? deps.vault!.fill(input, ctx.star.id) : input;
    const out = await tool.run(filled, ctx);
    const raw = typeof out === 'string' ? { content: out } : out;
    const res = { ...raw, content: redact(raw.content), ...(raw.summary ? { summary: redact(raw.summary) } : {}) };
    if (task && !QUIET_STEPS.has(tool.name)) {
      const summary = res.summary ?? tool.label(input);
      const kind = tool.name === 'update_progress' ? 'note' : STEP_KIND[tool.effectFor?.(input, { starId: ctx.star.id, browser: ctx.browser, workspaces: ctx.workspaces, vault: ctx.vault, companion: ctx.companion }) ?? tool.effect];
      const detail = res.content.length > 0 && res.content !== 'Noted.' && res.content !== summary ? truncate(res.content, 4000) : undefined;
      deps.store.addStep(task.id, { kind, summary: firstLine(summary, 160), ...(detail ? { detail } : {}), ...(tool.connection ? { connectionId: tool.connection } : {}) });
      deps.store.setActivity(firstLine(summary, 80), task.id);
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: res.content };
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    if (task) {
      deps.store.addStep(task.id, { kind: 'error', summary: firstLine(`${tool.label(input)} failed: ${message}`, 160), detail: message, ...(tool.connection ? { connectionId: tool.connection } : {}) });
    }
    return { type: 'tool_result', tool_use_id: toolUseId, content: `Error: ${message}`, is_error: true };
  }
}

const DOING: Record<string, string> = {
  remember: 'Updating memory', recall: 'Checking memory', forget_memories: 'Forgetting', update_progress: 'Working',
  notify_user: 'Writing to you', create_task: 'Setting up a task', list_tasks: 'Checking tasks', task_command: 'Updating a task',
  use_skill: 'Reading a skill', save_skill: 'Saving a skill', update_skill: 'Improving a skill', set_personality: 'Adjusting my style',
  list_stars: 'Checking the constellation', ask_star: 'Asking another Star', hand_off: 'Handing work over', message_star: 'Messaging a Star',
  browser_open: 'Browsing', browser_search: 'Searching the web', browser_snapshot: 'Reading the page', browser_click: 'Clicking',
  browser_type: 'Typing', browser_press: 'Pressing a key', browser_scroll: 'Scrolling', browser_back: 'Going back',
  browser_fill_login: 'Signing in', browser_ask_person: 'Waiting for you', files_list: 'Looking at my files', file_read: 'Reading a file',
  file_write: 'Writing a file', file_delete: 'Tidying my files', run_command: 'Running a command',
  computer_open: 'Opening a page for you', computer_list_files: 'Looking on your computer', computer_read_file: 'Reading a file on your computer',
  computer_write_file: 'Writing on your computer', computer_run: 'Running a program on your computer',
  search_email: 'Reading your inbox', read_email: 'Reading an email', draft_email: 'Drafting an email', send_email: 'Sending an email',
  archive_email: 'Tidying your inbox', list_events: 'Checking your calendar', create_event: 'Adding to your calendar',
  search_drive: 'Searching Drive', read_drive_file: 'Reading a document', github_search: 'Searching GitHub', github_read: 'Reading GitHub',
  github_notifications: 'Checking GitHub', github_comment: 'Commenting on GitHub', notion_search: 'Searching Notion', notion_read: 'Reading Notion',
  notion_append: 'Updating Notion', slack_post: 'Posting to Slack',
};

/** Short present-tense phrase for a tool, shown under the avatar while it runs. */
export const doingPhrase = (name: string) => DOING[name] ?? 'Working';

function linkConnection(deps: AgentDeps, taskId: string, connectionId: string) {
  const t = deps.store.findTask(taskId);
  if (t && !t.connectionIds.includes(connectionId)) deps.store.patchTask(taskId, { connectionIds: [...t.connectionIds, connectionId] });
}

export const errorResult = (toolUseId: string, message: string): BetaToolResultBlockParam =>
  ({ type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true });
