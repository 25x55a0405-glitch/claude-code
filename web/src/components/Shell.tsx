import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { doingLine, useAgent } from '../lib/agent';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { Icon, type IconName } from './Icon';
import { Me } from './ui';
import { ProfileSheet } from './ProfileSheet';

const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'goals', label: 'Goals', icon: 'target' },
  { id: 'ideas', label: 'Ideas', icon: 'bulb' },
  { id: 'approvals', label: 'Approvals', icon: 'approve' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'permissions', label: 'Permissions', icon: 'lock' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
];

export function Shell({ section, chatId, children }: { section: string; chatId?: string; children: ReactNode }) {
  const { status, settings } = useAgent();
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const convs = useResource(() => api.listConversations(), [], ['message.done']);
  const pending = status?.counts.pendingApprovals ?? 0;
  const side = convs.data?.filter((c) => !c.main) ?? [];
  const working = status?.state === 'working';

  useEffect(() => setDrawer(false), [section, chatId]);

  const newChat = async () => {
    const c = await api.createConversation();
    convs.reload();
    navigate('chat', c.id);
  };

  return (
    <div className="app">
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Navigation">
        <div className="sb-top">
          <a className="wordmark" href={href('chat')}>{settings?.agentName ?? 'Sky'}</a>
          <button className="icon-btn" onClick={newChat} aria-label="New side chat" title="New side chat"><Icon name="compose" /></button>
        </div>
        {NAV.map((n) => (
          <a key={n.id} href={href(n.id)} className={`sb-item ${section === n.id && !(n.id === 'chat' && chatId) ? 'on' : ''}`}>
            <Icon name={n.icon} size={18} />
            {n.label}
            {n.id === 'approvals' && pending > 0 && <span className="count">{pending}</span>}
          </a>
        ))}
        {side.length > 0 && <div className="sb-label">Side chats</div>}
        {side.map((c) => (
          <a key={c.id} href={href('chat', c.id)} className={`sb-item sb-chat ${chatId === c.id ? 'on' : ''}`}>
            <span className="t">{c.title}</span>
          </a>
        ))}
        <div className="sb-foot">
          <a href={href('settings')} className={`sb-item ${section === 'settings' ? 'on' : ''}`}>
            <span className="me">{(settings?.userName ?? '?')[0].toUpperCase()}</span>
            <span className="grow">{settings?.userName ?? ''}</span>
            <Icon name="settings" size={17} />
          </a>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setDrawer(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <button className="who" onClick={() => setSheet(true)} aria-label={`Open ${settings?.agentName ?? 'Sky'}’s profile`}>
            <Me size={34} />
            <span className="txt">
              <span className="name">{settings?.agentName ?? 'Sky'}</span>
              <span className={`doing ${working ? 'shimmer' : ''}`}>{doingLine(status)}</span>
            </span>
          </button>
          <span className="grow" />
          <a className="icon-btn" href={href('approvals')} aria-label={`Approvals${pending ? `, ${pending} waiting` : ''}`}>
            <Icon name="approve" />
            {pending > 0 && <span className="count">{pending}</span>}
          </a>
        </header>
        {children}
      </div>

      {sheet && <ProfileSheet onClose={() => setSheet(false)} />}
    </div>
  );
}
