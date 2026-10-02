import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AgentStatus, type Settings } from '../api';

interface AgentCtx {
  status: AgentStatus | null;
  settings: Settings | null;
  setSettings: (s: Settings) => void;
}

const Ctx = createContext<AgentCtx>({ status: null, settings: null, setSettings: () => {} });
export const useAgent = () => useContext(Ctx);

/** Live agent status and the user's settings (name, character), shared by every screen. */
export function AgentProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
    api.getSettings().then(setSettings).catch(() => {});
    return api.subscribe((e) => {
      if (e.type === 'status') setStatus(e.data);
      if (e.type === 'settings.updated') setSettings(e.data);
      if (e.type === 'approval.created' || e.type === 'approval.updated') api.getStatus().then(setStatus).catch(() => {});
    });
  }, []);
  return <Ctx.Provider value={{ status, settings, setSettings }}>{children}</Ctx.Provider>;
}

export function doingLine(status: AgentStatus | null): string {
  if (!status) return '';
  if (status.state === 'paused') return 'Paused. Not taking any actions';
  if (status.state === 'offline') return 'Offline';
  if (status.activity) return status.activity;
  if (status.state === 'waiting') return 'Waiting on you';
  return 'Keeping an eye on things';
}
