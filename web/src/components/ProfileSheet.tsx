import { useEffect, useState } from 'react';
import { api, type StarView } from '../api';
import { starLine, useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { href } from '../lib/router';
import { BrowserPip, BrowserWindow, useBrowserTab } from './BrowserView';
import { Icon } from './Icon';
import { StarAddress } from './StarAddress';
import { Bar, Segmented, StarFace, StatusChip, useToast } from './ui';

type Tab = 'now' | 'upcoming' | 'done';

/** Tap a Star to see who it is, what it's doing, and what it's tracking. */
export function ProfileSheet({ star, onClose }: { star: StarView; onClose: () => void }) {
  const { status, settings, stars, upsertStar } = useAgent();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('now');
  const tasks = useResource(() => api.listTasks(star.id ? { starId: star.id } : undefined), [star.id], ['task.updated']);
  const others = (stars ?? []).filter((s) => s.id !== star.id);
  const allPaused = status?.state === 'paused';
  const browser = useBrowserTab(star.id || undefined);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !watching && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, watching]);

  const list = (tasks.data ?? []).filter((t) =>
    tab === 'now' ? ['active', 'waiting_approval', 'blocked'].includes(t.status) : tab === 'upcoming' ? ['scheduled', 'paused'].includes(t.status) : ['done', 'failed'].includes(t.status),
  );
  const done = (tasks.data ?? []).filter((t) => t.status === 'done').length;
  const name = star.name;

  const pauseStar = async () => {
    try { upsertStar(await api.pauseStar(star.id, !star.paused)); } catch (e) { toast((e as Error).message); }
  };

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
            <StarFace star={star} size={112} track />
            <h1 style={{ fontSize: 26, marginTop: 10 }}>{name}</h1>
            <span className="handle">@{name.toLowerCase().replace(/\s+/g, '')} · {star.main ? `${settings?.userName ?? 'your'}’s main Star` : 'a Star'}</span>
            {star.role && <p className="t2" style={{ marginTop: 6, maxWidth: '34ch' }}>{star.role}</p>}
            {star.email && <div style={{ marginTop: 10, width: '100%', maxWidth: 340 }}><StarAddress star={star} compact /></div>}
            <span className="now-doing">
              <Icon name={allPaused || star.status.state === 'paused' ? 'pause' : 'sparkle'} size={14} />
              <span className={star.status.state === 'working' && !allPaused ? 'shimmer' : 't2'}>{starLine(star.status, status)}</span>
            </span>
          </div>

          <div className="stats">
            <a href={href('goals')} onClick={onClose}><div className="n">{star.status.activeTasks}</div><div className="k">Working on</div></a>
            <a href={href('approvals')} onClick={onClose}><div className="n" style={star.status.pendingApprovals ? { color: 'var(--attn)' } : undefined}>{star.status.pendingApprovals}</div><div className="k">Needs you</div></a>
            <a href={href('activity')} onClick={onClose}><div className="n">{star.id ? done : status?.counts.completedToday ?? 0}</div><div className="k">Finished</div></a>
          </div>

          {browser.tab && (
            <div>
              <div className="section-title">In the browser</div>
              <BrowserPip star={star} tab={browser.tab} onOpen={() => setWatching(true)} />
            </div>
          )}

          {star.id && (
            <a className="ws-link" href={href('workspace', star.id)} onClick={onClose}>
              <span className="glyph"><Icon name="folder" size={16} /></span>
              <span className="grow"><strong>Workspace</strong><span className="t3 xs">Its files and terminal</span></span>
              <Icon name="chevron" size={16} />
            </a>
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

          {others.length > 0 && (
            <div>
              <div className="section-title">Works with</div>
              <div className="crew">
                {others.map((s) => (
                  <a key={s.id} href={href('stars')} onClick={onClose} title={s.role}>
                    <StarFace star={s} size={40} />
                    <span>{s.name}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="rows">
              {[
                ...(star.id ? [[href('stars', star.id), 'edit', `Edit ${name}: role, apps, rules`]] : []),
                [href('stars'), 'sparkle', 'Your constellation'],
                [href('activity'), 'activity', 'Everything it has done'],
                [href('memory'), 'brain', 'What it remembers about you'],
                ...(star.main ? [[href('settings'), 'settings', `Customise ${name}`]] : []),
              ].map(([to, icon, label]) => (
                <a key={to} className="r" href={to} onClick={onClose}>
                  <Icon name={icon as 'activity'} size={17} />
                  <span className="grow">{label}</span>
                  <Icon name="chevron" size={16} />
                </a>
              ))}
            </div>
          </div>

          <div className="row wrap">
            {star.id && others.length > 0 && (
              <button className="btn" onClick={pauseStar} disabled={allPaused}>
                <Icon name={star.paused ? 'play' : 'pause'} size={15} />
                {star.paused ? `Wake ${name}` : `Pause ${name}`}
              </button>
            )}
            <button className="btn" onClick={() => api.setPaused(!allPaused)}>
              <Icon name={allPaused ? 'play' : 'pause'} size={15} />
              {others.length > 0 ? (allPaused ? 'Wake every Star' : 'Pause every Star') : allPaused ? `Wake ${name} up` : `Pause ${name}`}
            </button>
          </div>
        </div>
      </aside>
      {watching && browser.tab && <BrowserWindow star={star} tab={browser.tab} onTab={browser.setTab} onClose={() => setWatching(false)} />}
    </>
  );
}
