import type { MemoryCategory, TaskCommand, TaskKind } from '../../types.ts';
import { firstLine } from '../../util.ts';
import { relevantMemory } from '../memory.ts';
import { bool, num, schema, str, type ToolDef } from './types.ts';

const CATEGORIES: MemoryCategory[] = ['preference', 'fact', 'person', 'goal', 'style'];

export const remember: ToolDef<{ category: MemoryCategory; content: string; scope?: 'shared' | 'mine' }> = {
  name: 'remember',
  description: 'Save something durable about the person (a preference, fact, person, goal or writing style) so you can use it later. '
    + 'Use it when they tell you something worth keeping or correct you. Keep it to one short sentence. Do not save secrets. '
    + 'Memories are shared with every Star unless scope is "mine", for things only useful to your own role.',
  input_schema: schema({
    category: str('Kind of memory', { enum: CATEGORIES }),
    content: str('The memory, one sentence'),
    scope: str('shared (default) or mine', { enum: ['shared', 'mine'] }),
  }, ['category', 'content']),
  effect: 'internal',
  label: (i) => `Remembered: ${i.content}`,
  async run(i, ctx) {
    const dupe = ctx.store.listMemory(ctx.star.id).find((m) => m.content.toLowerCase() === i.content.toLowerCase());
    if (dupe) return 'Already remembered.';
    ctx.store.addMemory(i.category, i.content, ctx.source, true, ctx.task?.id, i.scope === 'mine' ? ctx.star.id : null);
    return i.scope === 'mine' ? 'Saved to your own memory.' : 'Saved to shared memory.';
  },
};

export const recall: ToolDef<{ query: string }> = {
  name: 'recall',
  description: 'Search what you remember about the person.',
  input_schema: schema({ query: str('What to look for') }, ['query']),
  effect: 'internal',
  label: (i) => `Checked memory for “${i.query}”`,
  async run(i, ctx) {
    const hits = relevantMemory(ctx.store.listMemory(ctx.star.id), i.query, 10);
    return hits.length ? hits.map((m) => `- [${m.category}] ${m.content}`).join('\n') : 'Nothing remembered about that.';
  },
};

export const updateProgress: ToolDef<{ summary: string; progress?: number }> = {
  name: 'update_progress',
  description: 'Record what you are doing or have just found, as one short line for the task timeline. Optionally estimate progress from 0 to 1.',
  input_schema: schema({ summary: str('One short line, past or present tense'), progress: num('0..1, optional') }, ['summary']),
  effect: 'internal',
  scope: 'task',
  label: (i) => i.summary,
  async run(i, ctx) {
    if (ctx.task && typeof i.progress === 'number') ctx.store.patchTask(ctx.task.id, { progress: Math.max(0, Math.min(1, i.progress)) });
    return 'Noted.';
  },
};

export const notifyUser: ToolDef<{ message: string; urgent?: boolean }> = {
  name: 'notify_user',
  description: 'Tell the person something they should know now (a result, a find, a problem). It reaches them on their chosen channels. '
    + 'Quiet hours hold back non-urgent messages. Do not use it for routine progress.',
  input_schema: schema({ message: str('What to tell them, short and plain'), urgent: bool('Only true if it cannot wait') }, ['message']),
  effect: 'internal',
  label: (i) => `Told you: ${firstLine(i.message, 80)}`,
  async run(i, ctx) {
    return ctx.runtime.notify(i.message, { urgent: i.urgent, taskId: ctx.task?.id, starId: ctx.star.id });
  },
};

export const finishTask: ToolDef<{ outcome: string; failed?: boolean }> = {
  name: 'finish_task',
  description: 'Call this once the work for this run is complete. The outcome is one line shown on the task card. '
    + 'Set failed only if the task cannot be done.',
  input_schema: schema({ outcome: str('One-line outcome'), failed: bool('True if the task could not be done') }, ['outcome']),
  effect: 'internal',
  scope: 'task',
  label: (i) => i.outcome,
  async run() {
    return 'Finished.';
  },
};

export const createTask: ToolDef<{ title: string; description: string; kind: TaskKind; schedule?: string }> = {
  name: 'create_task',
  description: 'Start background work. Use one_off for something to do now, recurring for something on a schedule, '
    + 'and watch to monitor something and act on changes. Write the description as a complete brief: what to do, what good looks like, '
    + 'and when to tell the person. Recurring and watch tasks need a plain-language schedule such as "Weekdays at 9:00" or "every 3 hours".',
  input_schema: schema({
    title: str('Short title, like a to-do item'),
    description: str('Complete brief for the task'),
    kind: str('one_off, recurring or watch', { enum: ['one_off', 'recurring', 'watch'] }),
    schedule: str('Plain-language schedule for recurring and watch tasks'),
  }, ['title', 'description', 'kind']),
  effect: 'internal',
  scope: 'chat',
  label: (i) => `Created task: ${i.title}`,
  async run(i, ctx) {
    const t = ctx.runtime.createTask({ title: i.title, description: i.description, kind: i.kind, schedule: i.schedule, starId: ctx.star.id }, ctx.source);
    ctx.touchedTasks.add(t.id);
    return `Created task ${t.id} (${t.status}${t.nextRunAt ? `, next run ${t.nextRunAt}` : ''}).`;
  },
};

export const listTasks: ToolDef<{ include_finished?: boolean }> = {
  name: 'list_tasks',
  description: 'List tasks with status and latest outcome. You see your own tasks; the main Star sees every Star’s.',
  input_schema: schema({ include_finished: bool('Also list done and failed tasks') }),
  effect: 'internal',
  scope: 'chat',
  label: () => 'Checked tasks',
  async run(i, ctx) {
    const tasks = ctx.store.listTasks(undefined, ctx.star.main ? undefined : ctx.star.id).filter((t) => i.include_finished || !['done', 'failed'].includes(t.status));
    if (!tasks.length) return 'No tasks.';
    const owner = (t: { starId?: string }) => ctx.star.main ? ` (${ctx.store.findStar(ctx.store.starIdOf(t))?.name ?? 'removed Star'})` : '';
    return tasks.map((t) => `- ${t.id} "${t.title}"${owner(t)} [${t.kind}, ${t.status}]${t.schedule ? ` schedule: ${t.schedule}` : ''}${t.lastOutcome ? ` latest: ${t.lastOutcome}` : ''}`).join('\n');
  },
};

export const commandTask: ToolDef<{ task_id: string; command: TaskCommand }> = {
  name: 'task_command',
  description: 'Pause, resume, run now, or cancel one of your tasks when the person asks.',
  input_schema: schema({ task_id: str('Task id from list_tasks'), command: str('What to do', { enum: ['pause', 'resume', 'run_now', 'cancel'] }) }, ['task_id', 'command']),
  effect: 'internal',
  scope: 'chat',
  label: (i) => `${i.command} ${i.task_id}`,
  async run(i, ctx) {
    const t = ctx.runtime.commandTask(i.task_id, i.command);
    ctx.touchedTasks.add(t.id);
    return `Task "${t.title}" is now ${t.status}.`;
  },
};

export const coreTools: ToolDef[] = [remember, recall, updateProgress, notifyUser, finishTask, createTask, listTasks, commandTask];
