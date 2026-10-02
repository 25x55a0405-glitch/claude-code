import type { Star, TaskKind } from '../../types.ts';
import { firstLine } from '../../util.ts';
import { schema, str, type ToolContext, type ToolDef } from './types.ts';

/** How deep a chain of ask_star requests may go (A asks B asks C asks D). */
export const MAX_ASK_DEPTH = 3;

/** The Star a call names, by name or id. Throws a message the model can act on. */
export function targetStar(ctx: Pick<ToolContext, 'store' | 'star'>, ref: string): Star {
  const target = ctx.store.findStar(ref);
  if (!target) {
    const names = ctx.store.listStars().filter((s) => s.id !== ctx.star.id).map((s) => s.name);
    throw new Error(`There’s no Star called “${ref}”.${names.length ? ` The others are: ${names.join(', ')}.` : ' You are the only Star.'}`);
  }
  if (target.id === ctx.star.id) throw new Error('That’s you. Do this yourself.');
  return target;
}

export const listStars: ToolDef<Record<string, never>> = {
  name: 'list_stars',
  description: 'List the Stars in your constellation: their names, roles, and whether they are paused.',
  input_schema: schema({}),
  effect: 'internal',
  label: () => 'Checked the constellation',
  async run(_i, ctx) {
    return ctx.store.listStars().map((s) => {
      const st = ctx.store.starStatus(s);
      return `- ${s.name}${s.id === ctx.star.id ? ' (you)' : ''}: ${s.role} [${st.state}, ${st.activeTasks} active task${st.activeTasks === 1 ? '' : 's'}]`;
    }).join('\n');
  },
};

/**
 * Handled by the task runner rather than run(): the asking task waits
 * (status "blocked") until the other Star finishes, then gets its answer as
 * the tool result.
 */
export const askStar: ToolDef<{ star: string; request: string }> = {
  name: 'ask_star',
  description: 'Ask another Star to do something or answer a question that you need before you can continue. '
    + 'Your task pauses until they finish, then you get their answer here. Write the request as a complete brief.',
  input_schema: schema({ star: str('The other Star’s name'), request: str('What you need from them, as a complete brief') }, ['star', 'request']),
  effect: 'internal',
  scope: 'task',
  label: (i) => `Asked ${i.star}: ${firstLine(i.request, 80)}`,
  async run() {
    throw new Error('ask_star only works inside a task');
  },
};

export const handOff: ToolDef<{ star: string; title: string; description: string; kind?: TaskKind; schedule?: string }> = {
  name: 'hand_off',
  description: 'Pass work to the Star whose role it fits. It becomes their task and they carry it on their own; you don’t wait for it. '
    + 'Recurring and watch work needs a plain-language schedule.',
  input_schema: schema({
    star: str('The Star to hand it to'),
    title: str('Short title, like a to-do item'),
    description: str('Complete brief: what to do, what good looks like, and when to tell the person'),
    kind: str('one_off (default), recurring or watch', { enum: ['one_off', 'recurring', 'watch'] }),
    schedule: str('Schedule for recurring and watch work'),
  }, ['star', 'title', 'description']),
  effect: 'internal',
  label: (i) => `Handed to ${i.star}: ${i.title}`,
  async run(i, ctx) {
    const target = targetStar(ctx, i.star);
    const t = ctx.runtime.createTask(
      { title: i.title, description: i.description, kind: i.kind ?? 'one_off', schedule: i.schedule, starId: target.id },
      ctx.star.name, { starId: ctx.star.id, ...(ctx.task ? { taskId: ctx.task.id } : {}) },
    );
    ctx.store.sendTeamMessage({ fromStarId: ctx.star.id, toStarId: target.id, kind: 'handoff', content: `${i.title}: ${firstLine(i.description, 300)}`, taskId: t.id });
    ctx.touchedTasks.add(t.id);
    return `Handed to ${target.name} as task ${t.id} (${t.status}).${target.paused ? ` ${target.name} is paused, so it will start when they’re resumed.` : ''}`;
  },
};

export const messageStar: ToolDef<{ star: string; message: string }> = {
  name: 'message_star',
  description: 'Send another Star a heads-up they’ll see next time they work. No reply comes back; use ask_star when you need an answer.',
  input_schema: schema({ star: str('The Star to tell'), message: str('The message, short and plain') }, ['star', 'message']),
  effect: 'internal',
  label: (i) => `Told ${i.star}: ${firstLine(i.message, 80)}`,
  async run(i, ctx) {
    const target = targetStar(ctx, i.star);
    ctx.store.sendTeamMessage({ fromStarId: ctx.star.id, toStarId: target.id, kind: 'message', content: i.message, ...(ctx.task ? { taskId: ctx.task.id } : {}) });
    return `Sent to ${target.name}.`;
  },
};

export const constellationTools: ToolDef[] = [listStars, askStar, handOff, messageStar];
