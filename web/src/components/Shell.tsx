import type { ReactNode } from 'react';
import { usingMock } from '../api';
import { href } from '../lib/router';
import { useStatus } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Orb, stateLabel } from './ui';

const NAV: { id: string; label: string; icon: IconName; mobile?: boolean }[] = [
  { id: 'home', label: 'Home', icon: 'home', mobile: true },
  { id: 'chat', label: 'Chat', icon: 'chat', mobile: true },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', mobile: true },
  { id: 'approvals', label: 'Approvals', icon: 'approve', mobile: true },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'connections', label: 'Connections', icon: 'plug' },
  { id: 'rules', label: 'Rules', icon: 'rules' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings', mobile: true },
];

export function Shell({ section, children }: { section: string; children: ReactNode }) {
  const status = useStatus();
  const pending = status?.counts.pendingApprovals ?? 0;
  const badge = (id: string) => (id === 'approvals' && pending > 0 ? <span className="badge">{pending}</span> : null);

  return (
    <>
      {usingMock && <div className="mock-banner">Demo mode: running on sample data. Set VITE_SKYS_API_URL to connect the back end.</div>}
      <div className="shell">
        <aside className="sidebar">
          <a className="brand" href={href('home')}>
            <Orb state={status?.state ?? 'idle'} size="sm" />
            Skys
          </a>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.id} href={href(n.id)} className={`navlink ${section === n.id ? 'active' : ''}`} aria-current={section === n.id ? 'page' : undefined}>
                <Icon name={n.icon} />
                {n.label}
                {badge(n.id)}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            {status && (
              <a className="status-chip" href={status.taskId ? href('tasks', status.taskId) : href('activity')}>
                <Orb state={status.state} size="xs" />
                <div style={{ minWidth: 0 }}>
                  <div className="label">{stateLabel[status.state]}</div>
                  <div className="line">{status.activity ?? (status.state === 'paused' ? 'Not taking any actions' : 'Watching for changes')}</div>
                </div>
              </a>
            )}
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {NAV.filter((n) => n.mobile).map((n) => (
          <a key={n.id} href={href(n.id)} className={section === n.id ? 'active' : ''} aria-current={section === n.id ? 'page' : undefined}>
            <Icon name={n.icon} size={20} />
            {n.label}
            {badge(n.id)}
          </a>
        ))}
      </nav>
    </>
  );
}
