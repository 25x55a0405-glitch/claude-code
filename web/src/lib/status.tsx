import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AgentStatus } from '../api';

const StatusCtx = createContext<AgentStatus | null>(null);
export const useStatus = () => useContext(StatusCtx);

/** Keeps the agent's live status available to every screen. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => {});
    return api.subscribe((e) => {
      if (e.type === 'status') setStatus(e.data);
      if (e.type === 'approval.created' || e.type === 'approval.updated') api.getStatus().then(setStatus).catch(() => {});
    });
  }, []);
  return <StatusCtx.Provider value={status}>{children}</StatusCtx.Provider>;
}
