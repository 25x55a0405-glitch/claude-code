import type { Store } from '../store.ts';
import type { Briefing, BriefingHighlight } from '../types.ts';
import { firstLine, iso, uid } from '../util.ts';
import type { Brain } from './brain.ts';
import { zonedParts } from './time.ts';

/**
 * The daily briefing. Highlights are assembled from real state (approvals,
 * finished work, finds, what's coming up, what's broken) so they are always
 * accurate; only the greeting summary is written by the model.
 */
export async function generateBriefing(store: Store, brain: Brain): Promise<Briefing> {
  const settings = store.settings();
  const since = iso(Date.now() - 24 * 3_600_000);
  const soon = iso(Date.now() + 24 * 3_600_000);
  const recent = store.activitySince(since);
  const h: BriefingHighlight[] = [];
  const add = (x: Omit<BriefingHighlight, 'id'>) => h.push({ id: uid('h'), ...x });

  for (const a of store.listApprovals('pending').slice(0, 3)) {
    add({ kind: 'needs_you', title: `${a.action} to ${a.target}`, detail: firstLine(a.reason, 140), approvalId: a.id, ...(a.taskId ? { taskId: a.taskId } : {}) });
  }
  for (const t of store.listTasks(['blocked', 'failed']).slice(0, 2)) {
    add({ kind: 'warning', title: t.title, detail: t.lastOutcome ?? (t.status === 'blocked' ? 'Blocked' : 'Failed'), taskId: t.id });
  }
  for (const c of store.listConnections().filter((c) => c.status === 'expired')) {
    add({ kind: 'warning', title: `${c.name} needs reconnecting`, detail: 'Its access expired, so tasks that use it are paused.' });
  }
  const done = recent.filter((e) => e.kind === 'task_completed').slice(0, 3);
  for (const e of done) add({ kind: 'done', title: firstLine(e.summary.replace(/^(Finished|Ran): /, ''), 80), detail: e.summary, ...(e.taskId ? { taskId: e.taskId } : {}) });
  for (const e of recent.filter((x) => x.kind === 'research' || x.kind === 'memory_learned').slice(0, 2)) {
    add({ kind: 'found', title: firstLine(e.summary, 80), detail: e.summary, ...(e.taskId ? { taskId: e.taskId } : {}) });
  }
  const upcoming = store.listTasks(['scheduled']).filter((t) => t.nextRunAt && t.nextRunAt <= soon)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, 3);
  for (const t of upcoming) {
    const p = zonedParts(new Date(t.nextRunAt!), settings.timezone);
    add({ kind: 'upcoming', title: t.title, detail: `Next run at ${p.hour}:${String(p.minute).padStart(2, '0')}`, taskId: t.id });
  }

  const hour = zonedParts(Date.now(), settings.timezone).hour;
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const greeting = `${part}, ${settings.userName}`;
  const facts = h.map((x) => `- ${x.kind}: ${x.title} (${x.detail})`).join('\n') || '- nothing notable';
  let summary = '';
  if (brain.name === 'claude') {
    try {
      summary = await brain.complete(
        `You are ${settings.agentName}, ${settings.userName}'s personal agent. Write the two-sentence summary at the top of their daily briefing. `
          + 'Plain, specific, no greeting, no lists, no markdown. Lead with what needs them, if anything.',
        `Today's items:\n${facts}\n\nActive tasks: ${store.status().counts.activeTasks}.`,
        300,
      );
    } catch {
      summary = '';
    }
  }
  if (!summary) {
    const needs = h.filter((x) => x.kind === 'needs_you').length;
    const doneCount = done.length;
    summary = [
      needs ? `${needs} thing${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} your OK.` : 'Nothing needs you right now.',
      doneCount ? `I finished ${doneCount} task${doneCount === 1 ? '' : 's'} since yesterday.` : '',
      upcoming.length ? `${upcoming.length} task${upcoming.length === 1 ? ' is' : 's are'} coming up today.` : '',
    ].filter(Boolean).join(' ');
  }
  const b: Briefing = { id: uid('b'), generatedAt: iso(), greeting, summary, highlights: h.slice(0, 8) };
  store.saveBriefing(b);
  return b;
}
