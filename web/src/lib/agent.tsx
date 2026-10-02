import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type AgentStatus, type Settings, type StarStatus, type StarView } from '../api';
import { href } from './router';

interface AgentCtx {
  status: AgentStatus | null;
  settings: Settings | null;
  setSettings: (s: Settings) => void;
  /** Every Star, main first. */
  stars: StarView[] | null;
  upsertStar: (s: StarView) => void;
  reloadStars: () => void;
}

const Ctx = createContext<AgentCtx>({ status: null, settings: null, setSettings: () => {}, stars: null, upsertStar: () => {}, reloadStars: () => {} });
export const useAgent = () => useContext(Ctx);

/** Live agent status, the user's settings and the Stars, shared by every screen. */
export function AgentProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stars, setStars] = useState<StarView[] | null>(null);
  const [noStars, setNoStars] = useState(false);
  const timer = useRef(0);

  const reloadStars = useCallback(() => {
    api.listStars().then((s) => { setStars(s); setNoStars(false); }, () => setNoStars(true));
  }, []);
  // A Star's status changes with every step, but star.updated only comes on edits,
  // so refresh the roster shortly after anything that moves its counts or state.
  const soon = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(reloadStars, 400);
  }, [reloadStars]);
  const upsertStar = useCallback((s: StarView) => {
    setStars((all) => {
      if (!all) return all;
      return all.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [...all, s];
    });
  }, []);

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
    api.getSettings().then(setSettings).catch(() => {});
    reloadStars();
    const off = api.subscribe((e) => {
      if (e.type === 'status') { setStatus(e.data); soon(); }
      if (e.type === 'settings.updated') { setSettings(e.data); soon(); }
      if (e.type === 'approval.created' || e.type === 'approval.updated') { api.getStatus().then(setStatus).catch(() => {}); soon(); }
      if (e.type === 'task.updated') soon();
      if (e.type === 'star.updated') upsertStar(e.data);
      if (e.type === 'star.deleted') setStars((all) => all && all.filter((s) => s.id !== e.data.id));
    });
    return () => { off(); window.clearTimeout(timer.current); };
  }, [reloadStars, soon, upsertStar]);

  // A server without Stars still gets one: the agent it always had.
  const roster = stars ?? (noStars && settings ? [soloStar(settings, status)] : null);
  return <Ctx.Provider value={{ status, settings, setSettings, stars: roster, upsertStar, reloadStars }}>{children}</Ctx.Provider>;
}

function soloStar(settings: Settings, status: AgentStatus | null): StarView {
  return {
    id: '', name: settings.agentName, role: 'Your agent', instructions: '', avatar: settings.avatar, main: true,
    autonomy: null, connectionIds: null, paused: false, conversationId: '', createdAt: '', updatedAt: '',
    status: {
      state: status?.state ?? 'idle', activity: status?.activity ?? null, taskId: status?.taskId ?? null,
      activeTasks: status?.counts.activeTasks ?? 0, pendingApprovals: status?.counts.pendingApprovals ?? 0,
    },
  };
}

export function doingLine(status: AgentStatus | null): string {
  if (!status) return '';
  if (status.state === 'paused') return 'Paused. Not taking any actions';
  if (status.state === 'offline') return 'Offline';
  if (status.activity) return status.activity;
  if (status.state === 'waiting') return 'Waiting on you';
  return 'Keeping an eye on things';
}

/** The same line for one Star. A global pause reads the same everywhere. */
export function starLine(s: StarStatus | undefined, global: AgentStatus | null): string {
  if (global?.state === 'paused') return doingLine(global);
  if (!s) return doingLine(global);
  if (s.state === 'paused') return 'Paused. Holding its work';
  if (s.state === 'offline') return 'Offline';
  if (s.activity) return s.activity;
  if (s.state === 'waiting') return 'Waiting on you';
  return 'Keeping an eye on things';
}

/** Where a Star's own chat lives. */
export const starChat = (s: Pick<StarView, 'main' | 'conversationId'>) => (s.main ? href('chat') : href('chat', s.conversationId));

export const mainStar = (stars: StarView[] | null) => stars?.find((s) => s.main) ?? null;
