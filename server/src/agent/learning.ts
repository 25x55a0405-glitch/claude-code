import type { Lesson, Star } from '../types.ts';
import { firstLine, iso, uid } from '../util.ts';
import type { AgentDeps } from './deps.ts';

export interface Correction {
  trigger: Lesson['trigger'];
  /** What happened, in plain words, for the reflection prompt. */
  situation: string;
  taskId?: string;
}

const SYSTEM = 'You help an assistant learn from a person’s corrections. You reply with one line of JSON and nothing else.';

/**
 * After a correction (a declined or edited approval, a failed task, or "no,
 * do it like this" in chat) the Star asks a small model what to do
 * differently next time. A lesson becomes a shared memory, or a line added to
 * the skill it's about, and the Star says so in its chat so the person can
 * undo it. Nothing is saved when there is no general lesson.
 */
export async function reflect(deps: AgentDeps, star: Star, c: Correction): Promise<Lesson | null> {
  const { store, brain } = deps;
  const settings = store.settings();
  if (settings.learnFromCorrections === false) return null;
  const skills = store.listSkills(star.id).filter((k) => k.source !== 'builtIn');
  const prompt = `A correction from the person to their assistant ${star.name} (${star.role}).\n\n${c.situation}\n\n`
    + `${skills.length ? `The assistant's skills: ${skills.map((k) => `"${k.name}"`).join(', ')}\n\n` : ''}`
    + 'What general lesson should the assistant keep for next time? Write it as a short instruction to itself, under 20 words, '
    + 'like "Keep emails to Maya under five lines". Only a lesson that will apply again; nothing about this one case, and nothing secret. '
    + 'If it belongs to one of the skills, name the skill.\n'
    + 'Reply exactly: {"lesson": "..." or null, "skill": "skill name" or null}';

  let answer: { lesson?: string | null; skill?: string | null };
  try {
    const chain = settings.smallProviderIds ?? star.providerIds;
    const raw = await brain.complete(SYSTEM, prompt, 200, chain);
    answer = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '{}');
  } catch {
    return null;
  }
  const text = typeof answer.lesson === 'string' ? firstLine(answer.lesson.trim(), 200) : '';
  if (!text) return null;
  if (store.listMemory(star.id).some((m) => m.content.toLowerCase() === text.toLowerCase())) return null;

  const lesson: Lesson = { id: uid('l'), starId: star.id, lesson: text, trigger: c.trigger, undone: false, createdAt: iso(), ...(c.taskId ? { taskId: c.taskId } : {}) };
  const skill = answer.skill ? skills.find((k) => k.name.toLowerCase() === String(answer.skill).toLowerCase()) : undefined;
  if (skill) {
    store.patchSkill(skill.id, { steps: `${skill.steps.trimEnd()}\n- Lesson: ${text}` }, { internal: true });
    store.saveLesson({ ...lesson, skillId: skill.id });
  } else {
    const m = store.addMemory('preference', text, `Learned from your correction (${c.trigger})`, true, c.taskId, null);
    store.saveLesson({ ...lesson, memoryId: m.id });
  }
  store.postAgentMessage(star.conversationId, `Got it. I’ll remember: ${text}${skill ? ` (added to my “${skill.name}” skill)` : ''}`, { lessonId: lesson.id });
  return store.getLesson(lesson.id);
}

/** Does a chat message read like "no, do it like this"? */
export const looksLikeCorrection = (text: string) =>
  /^\s*(no\b|nope\b|not like that|that'?s not|actually\b|instead\b|don[’']?t\b|do not\b|stop\b|wrong\b|please don[’']?t\b|never\b)/i.test(text);
