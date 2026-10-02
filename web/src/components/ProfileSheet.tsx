import { useEffect, useState } from 'react';
import { api } from '../api';
import { doingLine, useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { Bar, Me, Segmented, StatusChip } from './ui';

type Tab = 'now' | 'upcoming' | 'done';

/** Tap the character to see who it is, what it's doing, and what it's tracking. */
export function ProfileSheet({ onClose }: { onClose: () => void }) {
  const { status, settings } = useAgent();
  const [tab, setTab] = useState<Tab>('now');
  const tasks = useResource(() => api.listTasks(), [], ['task.updated']);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = (tasks.data ?? []).filter((t) =>
    tab === 'now' ? ['active', 'waiting_approval', 'blocked'].includes(t.status) : tab === 'upcoming' ? ['scheduled', 'paused'].includes(t.status) : ['done', 'failed'].includes(t.status),
  );
  const name = settings?.agentName ?? 'Sky';

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={`${name}’s profile`}>
        <div className="between" style={{ padding: '12px 12px 0' }}>
          <span />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="sheet-scroll">
          <div className="profile">
            <Me size={112} track />
            <h1 style={{ fontSize: 26, marginTop: 10 }}>{name}</h1>
            <span className="handle">@{name.toLowerCase().replace(/\s+/g, '')} · {settings?.userName}’s agent</span>
            <span className="now-doing">
              <Icon name={status?.state === 'paused' ? 'pause' : 'sparkle'} size={14} />
              <span className={status?.state === 'working' ? 'shimmer' : 't2'}>{doingLine(status)}</span>
            </span>
          </div>

          {status && (
            <div className="stats">
              <a href={href('goals')} onClick={onClose}><div className="n">{status.counts.activeTasks}</div><div className="k">Working on</div></a>
              <a href={href('approvals')} onClick={onClose}><div className="n" style={status.counts.pendingApprovals ? { color: 'var(--attn)' } : undefined}>{status.counts.pendingApprovals}</div><div className="k">Needs you</div></a>
              <a href={href('activity')} onClick={onClose}><div className="n">{status.counts.completedToday}</div><div className="k">Finished</div></a>
            </div>
          )}

          <div className="col">
            <Segmented label="Goals" value={tab} onChange={setTab} options={[{ value: 'now', label: 'Working on' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'done', label: 'Done' }]} />
            <div className="panel">
              <div className="rows">
                {list.length === 0 && <div className="r t3">Nothing here right now.</div>}
                {list.map((t) => (
                  <a key={t.id} className="r" href={href('goals', t.id)} onClick={onClose} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <div className="between"><h3 style={{ fontSize: 14 }}>{t.title}</h3><StatusChip status={t.status} /></div>
                    {t.lastOutcome && <span className="t3">{t.lastOutcome}</span>}
                    {t.progress !== undefined && t.status !== 'done' && <Bar value={t.progress} />}
                    {t.nextRunAt && tab === 'upcoming' && <span className="t3 xs">Next {relTime(t.nextRunAt)}</span>}
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="rows">
              {[
                ['activity', 'activity', 'Everything it has done'],
                ['permissions', 'lock', 'Permissions and rules'],
                ['memory', 'brain', 'What it remembers about you'],
                ['settings', 'settings', `Customise ${name}`],
              ].map(([to, icon, label]) => (
                <a key={to} className="r" href={href(to)} onClick={onClose}>
                  <Icon name={icon as 'activity'} size={17} />
                  <span className="grow">{label}</span>
                  <Icon name="chevron" size={16} />
                </a>
              ))}
            </div>
          </div>

          <button
            className="btn"
            onClick={() => api.setPaused(status?.state !== 'paused')}
          >
            <Icon name={status?.state === 'paused' ? 'play' : 'pause'} size={15} />
            {status?.state === 'paused' ? `Wake ${name} up` : `Pause ${name}`}
          </button>
        </div>
      </aside>
    </>
  );
}
