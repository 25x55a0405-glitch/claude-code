import { firstLine } from '../../util.ts';
import { schema, str, type ToolDef } from './types.ts';

export const useSkill: ToolDef<{ name: string }> = {
  name: 'use_skill',
  description: 'Read one of your skills (a saved recipe for a kind of task) before doing that kind of task. Follow its steps.',
  input_schema: schema({ name: str('The skill’s name, as listed in your instructions') }, ['name']),
  effect: 'internal',
  label: (i) => `Used the skill “${firstLine(i.name, 60)}”`,
  async run(i, ctx) {
    const k = ctx.store.findSkill(i.name, ctx.star.id);
    if (!k) throw new Error(`No skill called “${i.name}”. Your skills are: ${ctx.store.listSkills(ctx.star.id).map((s) => s.name).join(', ') || 'none yet'}.`);
    ctx.store.touchSkill(k.id);
    return `Skill “${k.name}” (use when: ${k.whenToUse})\n\n${k.steps}`;
  },
};

export const saveSkill: ToolDef<{ name: string; when_to_use: string; steps: string; scope?: 'shared' | 'mine' }> = {
  name: 'save_skill',
  description: 'Save a recipe for a kind of task you expect to do again, so you (and other Stars) can follow it next time. '
    + 'Use it when you worked out a good way to do something, or the person tells you how they want something done. '
    + 'Steps should be short, numbered and general, with no one-off details or secrets.',
  input_schema: schema({
    name: str('Short name, like "Weekly expense report"'),
    when_to_use: str('One sentence: when to use it'),
    steps: str('The recipe, as numbered steps'),
    scope: str('shared (default: every Star can use it) or mine', { enum: ['shared', 'mine'] }),
  }, ['name', 'when_to_use', 'steps']),
  effect: 'internal',
  label: (i) => `Saved the skill “${firstLine(i.name, 60)}”`,
  async run(i, ctx) {
    const k = ctx.store.addSkill({ name: firstLine(i.name, 80), whenToUse: firstLine(i.when_to_use, 300), steps: i.steps.slice(0, 8000), starId: i.scope === 'mine' ? ctx.star.id : null, source: 'star' });
    ctx.store.log('memory_learned', `New skill: ${k.name}`, ctx.task?.id, ctx.star.id);
    return `Saved “${k.name}”. The person can see and edit it on the Skills page.`;
  },
};

export const updateSkill: ToolDef<{ name: string; when_to_use?: string; steps?: string }> = {
  name: 'update_skill',
  description: 'Improve one of your skills: replace its steps or when-to-use line. Keep what still works.',
  input_schema: schema({ name: str('The skill’s name'), when_to_use: str('New when-to-use line'), steps: str('The full new steps') }, ['name']),
  effect: 'internal',
  label: (i) => `Updated the skill “${firstLine(i.name, 60)}”`,
  async run(i, ctx) {
    const k = ctx.store.findSkill(i.name, ctx.star.id);
    if (!k) throw new Error(`No skill called “${i.name}”.`);
    if (k.source === 'builtIn') throw new Error('Built-in skills can’t be changed.');
    ctx.store.patchSkill(k.id, {
      ...(i.when_to_use ? { whenToUse: firstLine(i.when_to_use, 300) } : {}),
      ...(i.steps ? { steps: i.steps.slice(0, 8000) } : {}),
    });
    return `Updated “${k.name}”.`;
  },
};

export const forgetMemories: ToolDef<{ ids: string[] }> = {
  name: 'forget_memories',
  description: 'Delete memories by id when the person asks you to forget something. Find the ids with recall first. Only delete what they asked about.',
  input_schema: schema({ ids: { type: 'array', items: { type: 'string' }, description: 'Memory ids from recall' } }, ['ids']),
  effect: 'internal',
  label: (i) => `Forgot ${i.ids.length} thing${i.ids.length === 1 ? '' : 's'}`,
  async run(i, ctx) {
    const visible = new Map(ctx.store.listMemory(ctx.star.id).map((m) => [m.id, m]));
    const gone = i.ids.filter((id) => visible.has(id));
    for (const id of gone) ctx.store.deleteMemory(id);
    if (gone.length) ctx.store.log('memory_learned', `Forgot ${gone.length} memor${gone.length === 1 ? 'y' : 'ies'} when you asked`, ctx.task?.id, ctx.star.id);
    const missing = i.ids.length - gone.length;
    return `Forgot ${gone.length}.${missing ? ` ${missing} id${missing === 1 ? ' was' : 's were'} not found.` : ''}`;
  },
};

export const setPersonality: ToolDef<{ personality?: string; reply_style?: string }> = {
  name: 'set_personality',
  description: 'Change your own personality or reply style when the person asks ("be funnier", "shorter answers"). '
    + 'Write the whole new text, keeping the parts they didn’t ask to change. An empty string resets it.',
  input_schema: schema({
    personality: str('Your character, in a sentence or two'),
    reply_style: str('How your replies should look'),
  }),
  effect: 'internal',
  scope: 'chat',
  label: () => 'Updated my personality',
  async run(i, ctx) {
    if (i.personality === undefined && i.reply_style === undefined) throw new Error('Give a personality or a reply_style.');
    const s = ctx.store.patchStar(ctx.star.id, {
      ...(i.personality !== undefined ? { personality: i.personality.trim().slice(0, 1000) } : {}),
      ...(i.reply_style !== undefined ? { replyStyle: i.reply_style.trim().slice(0, 1000) } : {}),
    });
    ctx.star = s;
    return 'Updated. It applies from your next reply; the person can change or reset it in the Star’s settings.';
  },
};

export const skillTools: ToolDef[] = [useSkill, saveSkill, updateSkill, forgetMemories, setPersonality];
