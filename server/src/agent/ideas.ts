import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import type { Idea, IdeaKind } from '../types.ts';
import { firstLine } from '../util.ts';
import type { Brain } from './brain.ts';
import { formatMemory } from './prompt.ts';

type Draft = Omit<Idea, 'id' | 'createdAt'>;

/** Ideas that follow directly from what's connected, offered once each. */
function starterIdeas(store: Store, providers: Providers): Draft[] {
  const tasks = store.listTasks().map((t) => `${t.title} ${t.description}`.toLowerCase()).join('\n');
  const out: Draft[] = [];
  if (providers.isUsable('gmail') && !/inbox|email/.test(tasks)) {
    out.push({ kind: 'suggestion', title: 'Keep your inbox tidy', detail: 'I can triage new email a few times a day: archive the noise, draft replies, and flag what needs you.', prompt: 'Every 2 hours from 8:00 to 20:00, triage my inbox: archive newsletters and notifications, draft replies for anything that needs me, and tell me about anything urgent.' });
  }
  if (providers.isUsable('calendar') && !/calendar|meeting|agenda/.test(tasks)) {
    out.push({ kind: 'suggestion', title: 'A heads-up before each day', detail: 'Each weekday morning I can walk through your calendar and flag clashes or prep you need.', prompt: 'Weekdays at 7:30, look at my calendar for the day, flag clashes, and tell me what to prepare.' });
  }
  if (providers.isUsable('github') && !/pull request|github|shipped/.test(tasks)) {
    out.push({ kind: 'suggestion', title: 'Weekly “what I shipped” note', detail: 'Every Friday I can summarise your merged pull requests and finished tasks.', prompt: 'Every Friday at 17:00, summarise what I shipped this week from GitHub and my finished tasks.' });
  }
  if (!store.listMemory().some((m) => m.category === 'goal')) {
    out.push({ kind: 'tip', title: 'Tell me what you’re working toward', detail: 'With a few goals in memory I can research on my own and suggest better ideas.', prompt: 'Ask me about my goals for the next few months and remember them.' });
  }
  return out;
}

const KINDS: IdeaKind[] = ['suggestion', 'tip', 'plan_update'];

/** Asks the model for a few ideas grounded in goals, preferences, tasks and recent activity. */
async function modelIdeas(store: Store, brain: Brain): Promise<Draft[]> {
  const memory = store.listMemory().filter((m) => ['goal', 'preference', 'fact'].includes(m.category)).slice(0, 30);
  if (!memory.length) return [];
  const tasks = store.listTasks().filter((t) => !['done', 'failed'].includes(t.status)).map((t) => `- ${t.title} (${t.kind}${t.schedule ? `, ${t.schedule}` : ''})`).join('\n') || '- none';
  const recent = store.activity(null, 30).items.map((e) => `- ${e.summary}`).join('\n');
  const seen = [...store.seenIdeaTitles()].slice(-40).join('; ');
  const answer = await brain.complete(
    'You suggest a few concrete things a personal agent could do next for its person. Reply with JSON only.',
    `What you know:\n${formatMemory(memory)}\n\nTheir current tasks:\n${tasks}\n\nRecent activity:\n${recent}\n\nAlready suggested (don't repeat): ${seen || 'nothing yet'}\n\n`
      + 'Suggest up to 3 ideas that would genuinely help and that the agent could do with web research, email, calendar or reminders. '
      + 'Return a JSON array of {"kind": "suggestion" | "tip" | "plan_update", "title": short, "detail": one sentence on why, '
      + '"prompt": the exact request the person would send to start it, in first person}. Return [] if nothing is worth suggesting.',
    1500,
  );
  const json = /\[[\s\S]*\]/.exec(answer)?.[0];
  if (!json) return [];
  try {
    return (JSON.parse(json) as Partial<Draft>[])
      .filter((x) => x.title && x.prompt && KINDS.includes(x.kind as IdeaKind))
      .slice(0, 3)
      .map((x) => ({ kind: x.kind as IdeaKind, title: firstLine(x.title!, 80), detail: firstLine(x.detail ?? '', 200), prompt: x.prompt!.trim().slice(0, 1000) }));
  } catch {
    return [];
  }
}

/** Adds any new ideas and returns them. */
export async function refreshIdeas(store: Store, providers: Providers, brain: Brain): Promise<Idea[]> {
  const drafts = [...starterIdeas(store, providers)];
  if (brain.name === 'claude') drafts.push(...(await modelIdeas(store, brain).catch(() => [])));
  return drafts.map((d) => store.addIdea(d)).filter((x): x is Idea => Boolean(x));
}
