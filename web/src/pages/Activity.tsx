import { api, type ActivityEvent, type ActivityKind } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Empty, ErrorNote, Skeleton } from '../components/ui';
import { clockTime, dayLabel } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';

const META: Record<ActivityKind, { icon: IconName; color: string }> = {
  task_started: { icon: 'play', color: 'var(--sky)' },
  task_completed: { icon: 'check', color: 'var(--ok)' },
  task_failed: { icon: 'alert', color: 'var(--danger)' },
  approval_requested: { icon: 'bolt', color: 'var(--dawn)' },
  approval_resolved: { icon: 'approve', color: 'var(--ok)' },
  memory_learned: { icon: 'brain', color: 'var(--violet)' },
  research: { icon: 'search', color: 'var(--sky)' },
  message: { icon: 'chat', color: 'var(--text-2)' },
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
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="sub">A complete log of what Skys has done, including work in the background.</p>
        </div>
      </div>
      {feed.error ? (
        <ErrorNote error={feed.error} retry={feed.reload} />
      ) : !feed.data ? (
        <Skeleton h={48} n={6} />
      ) : groups.length === 0 ? (
        <Empty icon="activity" title="No activity yet" />
      ) : (
        groups.map(([label, items]) => (
          <section key={label} className="card">
            <div className="day-label">{label}</div>
            <div className="list">
              {items.map((e) => {
                const m = META[e.kind];
                const row = (
                  <>
                    <div className="icon-tile" style={{ color: m.color }}><Icon name={m.icon} size={16} /></div>
                    <span style={{ flex: 1 }}>{e.summary}</span>
                    <span className="faint">{clockTime(e.at)}</span>
                  </>
                );
                return e.taskId ? (
                  <a key={e.id} className="list-item" href={href('tasks', e.taskId)}>{row}</a>
                ) : (
                  <div key={e.id} className="list-item">{row}</div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
