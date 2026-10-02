import { useState } from 'react';
import { api, type Autonomy, type Connection } from '../api';
import { Icon } from '../components/Icon';
import { ConnectionChip, ErrorNote, PageHead, Segmented, Skeleton, Switch, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';

const AUTONOMY: { value: Autonomy; title: string; body: string }[] = [
  { value: 'ask', title: 'Ask first', body: 'Researches and drafts, then checks with you before every action.' },
  { value: 'balanced', title: 'Balanced', body: 'Handles routine things. Waits for you on anything that sends, spends or deletes.' },
  { value: 'autonomous', title: 'Hands-off', body: 'Acts on its own and tells you after. Safety rules still apply.' },
];

export const LOGO: Record<string, string> = { gmail: '#ea4335', calendar: '#1a73e8', github: '#24292f', web: '#6b7280', notion: '#191919', slack: '#4a154b', drive: '#188038', telegram: '#229ed9' };

export function Permissions() {
  const toast = useToast();
  const { settings, setSettings, stars } = useAgent();
  const conns = useResource(() => api.listConnections(), []);
  const rules = useResource(() => api.listRules(), []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const replace = (c: Connection) => conns.setData((d) => d && d.map((x) => (x.id === c.id ? c : x)));
  const connect = async (c: Connection) => {
    setBusy(c.id);
    try {
      const res = await api.connect(c.id);
      if (res.authorizeUrl) { window.location.href = res.authorizeUrl; return; }
      replace(res.connection);
      toast(`${c.name} connected`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHead title="Permissions" sub="How far your Stars can go on their own, which apps they can use, and the lines they never cross. Each Star can be set tighter on its own page." />

      <section>
        <div className="section-title">Independence</div>
        <div className="autonomy">
          {AUTONOMY.map((a) => (
            <button key={a.value} aria-pressed={settings?.autonomy === a.value} onClick={async () => { setSettings(await api.updateSettings({ autonomy: a.value })); toast(a.title); }}>
              <h3>{a.title}</h3>
              <span>{a.body}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-title">Apps</div>
        {conns.error ? <ErrorNote error={conns.error} retry={conns.reload} /> : !conns.data ? <Skeleton h={60} n={4} /> : (
          <div className="panel">
            <div className="rows">
              {conns.data.map((c) => (
                <div key={c.id} className="r" style={{ flexWrap: 'wrap' }}>
                  <div className="app-logo" style={{ background: LOGO[c.provider] ?? '#6b7280' }}>{c.name[0]}</div>
                  <div className="grow">
                    <h3>{c.name}</h3>
                    <p className="t3 xs">{c.status === 'connected' ? `${c.description} · synced ${relTime(c.lastSyncAt)}` : c.description}</p>
                  </div>
                  {c.status === 'connected' ? (
                    <div className="row">
                      <Segmented label={`${c.name} access`} value={c.access} onChange={async (access) => replace(await api.updateConnection(c.id, { access }))} options={[{ value: 'read', label: 'Look only' }, { value: 'read_write', label: 'Look and act' }]} />
                      <button className="icon-btn" aria-label={`Disconnect ${c.name}`} title="Disconnect" onClick={async () => { replace(await api.disconnect(c.id)); toast(`${c.name} disconnected`); }}><Icon name="x" size={16} /></button>
                    </div>
                  ) : (
                    <div className="row">
                      {c.status === 'expired' && <ConnectionChip status={c.status} />}
                      <button className="btn sm" disabled={busy === c.id} onClick={() => connect(c)}>{busy === c.id ? 'Connecting…' : c.status === 'expired' ? 'Reconnect' : 'Connect'}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="section-title">Rules</div>
        <div className="panel">
          <div className="rows">
            {rules.error ? <div className="r"><ErrorNote error={rules.error} retry={rules.reload} /></div> : !rules.data ? <div className="r"><Skeleton h={30} n={3} /></div> : rules.data.map((r) => (
              <div key={r.id} className="r">
                <div className="grow">
                  <p style={{ opacity: r.enabled ? 1 : 0.5 }}>{r.text}</p>
                  {r.builtIn && <p className="t3 xs">Always on</p>}
                  {r.starId && <p className="t3 xs">Only for {stars?.find((s) => s.id === r.starId)?.name ?? 'one Star'}</p>}
                </div>
                {!r.builtIn && <button className="icon-btn" aria-label="Delete rule" onClick={async () => { await api.deleteRule(r.id); rules.setData((d) => d && d.filter((x) => x.id !== r.id)); }}><Icon name="trash" size={16} /></button>}
                <Switch label={r.text} checked={r.enabled} disabled={r.builtIn} onChange={async (enabled) => { const u = await api.updateRule(r.id, { enabled }); rules.setData((d) => d && d.map((x) => (x.id === r.id ? u : x))); }} />
              </div>
            ))}
            <form className="r" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; const r = await api.addRule(text.trim()); rules.setData((d) => [...(d ?? []), r]); setText(''); }}>
              <input id="rule-new" className="grow" style={{ border: 'none', outline: 'none', background: 'transparent', padding: '6px 0' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a rule, like “Never book flights with two stops”" aria-label="New rule" />
              <button className="btn sm" disabled={!text.trim()}>Add</button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}
