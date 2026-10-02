import { useEffect, useState, type ReactNode } from 'react';
import { api, type StarView } from '../api';
import { mainStar, starChat, starLine, useAgent } from '../lib/agent';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { Icon, type IconName } from './Icon';
import { StarFace } from './ui';
import { ProfileSheet } from './ProfileSheet';

const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: 'goals', label: 'Goals', icon: 'target' },
  { id: 'ideas', label: 'Ideas', icon: 'bulb' },
  { id: 'approvals', label: 'Approvals', icon: 'approve' },
  { id: 'stars', label: 'Constellation', icon: 'sparkle' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'permissions', label: 'Permissions', icon: 'lock' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
];

/**
 * The frame around every screen: the Stars and navigation on the left, and the
 * current Star's face and live status on top.
 */
export function Shell({ section, chatId, starId, children }: { section: string; chatId?: string; starId?: string; children: ReactNode }) {
  const { status, settings, stars } = useAgent();
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const convs = useResource(() => api.listConversations(), [], ['message.done', 'star.updated', 'star.deleted']);
  const pending = status?.counts.pendingApprovals ?? 0;

  const homes = new Set((stars ?? []).map((s) => s.conversationId));
  const chatConv = chatId ? convs.data?.find((c) => c.id === chatId) : undefined;
  const main = mainStar(stars);
  // Which Star the screen is about: the one whose chat is open, or the one being edited.
  const current: StarView | null =
    (starId && stars?.find((s) => s.id === starId)) ||
    (chatConv?.starId && stars?.find((s) => s.id === chatConv.starId)) ||
    (chatId && stars?.find((s) => s.conversationId === chatId)) ||
    main;
  const side = (convs.data ?? []).filter((c) => !c.main && !homes.has(c.id) && (c.starId ?? main?.id) === current?.id);
  const onHome = (s: StarView) => section === 'chat' && (s.main ? !chatId : chatId === s.conversationId);
  const name = current?.name ?? settings?.agentName ?? 'Sky';

  useEffect(() => { setDrawer(false); setSheet(false); }, [section, chatId, starId]);

  const newChat = async () => {
    const c = await api.createConversation(current && !current.main ? current.id : undefined);
    convs.reload();
    navigate('chat', c.id);
  };

  return (
    <div className="app">
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Navigation">
        <div className="sb-top">
          <a className="wordmark" href={href('chat')}>Sky</a>
          <button className="icon-btn" onClick={newChat} aria-label="New side chat" title="New side chat"><Icon name="compose" /></button>
        </div>

        <div className="sb-label" style={{ paddingTop: 4 }}>Stars</div>
        {stars?.map((s) => (
          <a key={s.id} href={starChat(s)} className={`sb-item sb-star ${onHome(s) ? 'on' : ''}`} aria-label={`${s.name}’s chat`}>
            <StarFace star={s} size={24} />
            <span className="t">{s.name}</span>
            {s.status.pendingApprovals > 0 ? <span className="count">{s.status.pendingApprovals}</span> : s.status.state === 'working' && status?.state !== 'paused' ? <span className="live-dot" title="Working" /> : s.paused ? <Icon name="pause" size={13} /> : null}
          </a>
        ))}
        <a href={href('stars', 'new')} className={`sb-item sb-new ${section === 'stars' && starId === 'new' ? 'on' : ''}`}>
          <span className="plus"><Icon name="plus" size={14} /></span>
          New Star
        </a>

        <div className="sb-gap" />
        {NAV.map((n) => (
          <a key={n.id} href={href(n.id)} className={`sb-item ${section === n.id && !(n.id === 'stars' && starId) ? 'on' : ''}`}>
            <Icon name={n.icon} size={18} />
            {n.label}
            {n.id === 'approvals' && pending > 0 && <span className="count">{pending}</span>}
          </a>
        ))}
        {side.length > 0 && <div className="sb-label">Side chats{current && stars && stars.length > 1 ? ` with ${current.name}` : ''}</div>}
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
          <button className="who" onClick={() => setSheet(true)} aria-label={`Open ${name}’s profile`}>
            {current ? <StarFace star={current} size={34} /> : <span style={{ width: 34 }} />}
            <span className="txt">
              <span className="name">{name}</span>
              <span className={`doing ${current?.status.state === 'working' && status?.state !== 'paused' ? 'shimmer' : ''}`}>{starLine(current?.status, status)}</span>
            </span>
          </button>
          <span className="grow" />
          {stars && stars.length > 1 && (
            <a className="orbit" href={href('stars')} aria-label="Your constellation" title="Your constellation">
              {stars.slice(0, 4).map((s) => <StarFace key={s.id} star={s} size={22} still />)}
            </a>
          )}
          <a className="icon-btn" href={href('approvals')} aria-label={`Approvals${pending ? `, ${pending} waiting` : ''}`}>
            <Icon name="approve" />
            {pending > 0 && <span className="count">{pending}</span>}
          </a>
        </header>
        {children}
      </div>

      {sheet && current && <ProfileSheet star={current} onClose={() => setSheet(false)} />}
    </div>
  );
}
