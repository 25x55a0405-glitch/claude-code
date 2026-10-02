import { useState } from 'react';
import { api, type Connection } from '../api';
import { ConnectionPill, ErrorNote, Segmented, Skeleton, useToast } from '../components/ui';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';

const LOGO: Record<string, string> = {
  gmail: '#ea4335',
  calendar: '#1a73e8',
  github: '#24292f',
  web: '#5ab8ff',
  notion: '#2f2f2f',
  slack: '#611f69',
  drive: '#0f9d58',
  telegram: '#2aabee',
};

export function Connections() {
  const toast = useToast();
  const list = useResource(() => api.listConnections(), []);
  const [busy, setBusy] = useState<string | null>(null);

  const replace = (c: Connection) => list.setData((d) => d && d.map((x) => (x.id === c.id ? c : x)));

  const connect = async (c: Connection) => {
    setBusy(c.id);
    try {
      const res = await api.connect(c.id);
      if (res.authorizeUrl) {
        window.location.href = res.authorizeUrl;
        return;
      }
      replace(res.connection);
      toast(`${c.name} connected`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <p className="sub">The apps Skys can use. Read-only lets Skys look and research; read and act lets it make changes, always within your rules.</p>
        </div>
      </div>
      {list.error ? (
        <ErrorNote error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <Skeleton h={150} n={4} />
      ) : (
        <div className="grid-2">
          {list.data.map((c) => (
            <article key={c.id} className="card conn">
              <div className="row-between">
                <div className="row">
                  <div className="conn-logo" style={{ background: LOGO[c.provider] ?? 'var(--violet)' }}>{c.name[0]}</div>
                  <div>
                    <h3>{c.name}</h3>
                    <p className="faint">{c.description}</p>
                  </div>
                </div>
                <ConnectionPill status={c.status} />
              </div>
              {c.status === 'connected' ? (
                <div className="row-between">
                  <Segmented
                    label={`${c.name} access`}
                    value={c.access}
                    onChange={async (access) => replace(await api.updateConnection(c.id, { access }))}
                    options={[{ value: 'read', label: 'Read only' }, { value: 'read_write', label: 'Read and act' }]}
                  />
                  <button className="btn btn-sm btn-ghost" onClick={async () => { replace(await api.disconnect(c.id)); toast(`${c.name} disconnected`); }}>Disconnect</button>
                </div>
              ) : (
                <div className="row-between">
                  <span className="faint">{c.status === 'expired' ? `Access expired ${relTime(c.lastSyncAt)}` : 'Not connected'}</span>
                  <button className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => connect(c)}>
                    {busy === c.id ? 'Connecting…' : c.status === 'expired' ? 'Reconnect' : 'Connect'}
                  </button>
                </div>
              )}
              {c.status === 'connected' && c.lastSyncAt && <p className="faint">Synced {relTime(c.lastSyncAt)}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
