import { api, type ActivityEvent, type ActivityKind } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Skeleton } from '../components/ui';
import { clockTime, dayLabel } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';

const ICON: Record<ActivityKind, IconName> = {
  task_started: 'play', task_completed: 'check', task_failed: 'alert', approval_requested: 'bolt',
  approval_resolved: 'approve', memory_learned: 'brain', research: 'search', message: 'chat',
};

export function Activity() {
  const feed = useResource(() => api.listActivity(), [], ['activity']);
  const groups: [string, ActivityEvent[]][] = [];
  for (const e of feed.data?.items ?? []) {
    const label = dayLabel(e.at);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(e);
    else groups.push([label, [e]]);
  }

  return (
    <div className="page">
      <PageHead title="Activity" sub="Everything Sky has done, including the work it does while you’re away." />
      {feed.error ? <ErrorNote error={feed.error} retry={feed.reload} /> : !feed.data ? <Skeleton h={48} n={6} /> : groups.length === 0 ? <Empty title="Nothing yet" /> : groups.map(([label, items]) => (
        <section key={label}>
          <div className="section-title">{label}</div>
          <div className="panel">
            <div className="rows">
              {items.map((e) => {
                const inner = (
                  <>
                    <div className="glyph" style={e.kind === 'approval_requested' ? { color: 'var(--attn)' } : e.kind === 'task_failed' ? { color: 'var(--danger)' } : e.kind === 'task_completed' ? { color: 'var(--ok)' } : undefined}><Icon name={ICON[e.kind]} size={16} /></div>
                    <span className="grow">{e.summary}</span>
                    <span className="t3 xs num">{clockTime(e.at)}</span>
                  </>
                );
                return e.taskId ? <a key={e.id} className="r" href={href('goals', e.taskId)}>{inner}</a> : <div key={e.id} className="r">{inner}</div>;
              })}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
