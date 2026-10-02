import { useState } from 'react';
import { api, type Autonomy } from '../api';
import { Icon } from '../components/Icon';
import { ErrorNote, Skeleton, Toggle, useToast } from '../components/ui';
import { useResource } from '../lib/hooks';

const AUTONOMY: { value: Autonomy; title: string; body: string }[] = [
  { value: 'ask', title: 'Ask first', body: 'Skys researches and drafts, but asks before every action.' },
  { value: 'balanced', title: 'Balanced', body: 'Routine actions happen on their own. Anything that sends, spends or deletes waits for you.' },
  { value: 'autonomous', title: 'Hands-off', body: 'Skys acts on its own and tells you after. Built-in rules still apply.' },
];

export function Rules() {
  const toast = useToast();
  const rules = useResource(() => api.listRules(), []);
  const settings = useResource(() => api.getSettings(), []);
  const [text, setText] = useState('');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Rules</h1>
          <p className="sub">How far Skys can go on its own, and the lines it never crosses.</p>
        </div>
      </div>

      <section className="stack">
        <h2>Autonomy</h2>
        <div className="autonomy">
          {AUTONOMY.map((a) => (
            <button
              key={a.value}
              aria-pressed={settings.data?.autonomy === a.value}
              onClick={async () => {
                settings.setData(await api.updateSettings({ autonomy: a.value }));
                toast(`Autonomy set to ${a.title}`);
              }}
            >
              <h3>{a.title}</h3>
              <span className="faint">{a.body}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Your rules</h2></div>
        <form
          className="row"
          style={{ marginBottom: 16, flexWrap: 'nowrap' }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const r = await api.addRule(text.trim());
            rules.setData((d) => [...(d ?? []), r]);
            setText('');
          }}
        >
          <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Never book flights with more than one stop" aria-label="New rule" />
          <button className="btn btn-primary" disabled={!text.trim()}><Icon name="plus" size={16} /> Add</button>
        </form>
        {rules.error ? (
          <ErrorNote error={rules.error} retry={rules.reload} />
        ) : !rules.data ? (
          <Skeleton h={40} n={4} />
        ) : (
          <div className="list">
            {rules.data.map((r) => (
              <div key={r.id} className="list-item">
                <div style={{ flex: 1 }}>
                  <p style={{ opacity: r.enabled ? 1 : 0.55 }}>{r.text}</p>
                  {r.builtIn && <p className="faint">Built-in safety rule, always on</p>}
                </div>
                {!r.builtIn && (
                  <button
                    className="btn btn-ghost btn-sm btn-danger"
                    aria-label="Delete rule"
                    onClick={async () => {
                      await api.deleteRule(r.id);
                      rules.setData((d) => d && d.filter((x) => x.id !== r.id));
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                )}
                <Toggle
                  label={r.text}
                  checked={r.enabled}
                  disabled={r.builtIn}
                  onChange={async (enabled) => {
                    const u = await api.updateRule(r.id, { enabled });
                    rules.setData((d) => d && d.map((x) => (x.id === r.id ? u : x)));
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
