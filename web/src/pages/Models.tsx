import { useEffect, useState } from 'react';
import { api, type ModelProvider, type ProviderInput, type ProviderKind, type ProviderPreset, type ProviderTest } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Segmented, Skeleton, StarFace, Switch, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href } from '../lib/router';

export const KIND_LABEL: Record<ProviderKind, string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic-compatible' };

/** Minutes or seconds until a time, for "back in 3m". */
function until(at: string | null) {
  if (!at) return '';
  const s = Math.max(0, Math.round((new Date(at).getTime() - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
}

/** One line on how a model is doing: working, resting after a limit, or broken. */
export function HealthChip({ p }: { p: ModelProvider }) {
  const h = p.health;
  if (!p.enabled) return <span className="chip">Off</span>;
  const cooling = h.state === 'cooling' && h.cooldownUntil && new Date(h.cooldownUntil).getTime() > Date.now();
  if (cooling) return <span className="chip warn" title={h.lastError ?? undefined}><span className="dot" />Resting · back in {until(h.cooldownUntil)}</span>;
  if (h.state === 'failing') return <span className="chip danger" title={h.lastError ?? undefined}><span className="dot" />Needs fixing</span>;
  if (h.state === 'ok' || h.state === 'cooling') return <span className="chip ok"><span className="dot" />Working{h.latencyMs ? ` · ${(h.latencyMs / 1000).toFixed(1)}s` : ''}</span>;
  return <span className="chip"><span className="dot" />Not used yet</span>;
}

export function Models() {
  const toast = useToast();
  const { stars, settings, setSettings } = useAgent();
  const list = useResource(() => api.listProviders(), [], ['provider.updated', 'provider.deleted']);
  const [editing, setEditing] = useState<ModelProvider | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTest | 'running'>>({});
  const [drag, setDrag] = useState<string | null>(null);
  const [, tick] = useState(0);

  // Countdowns on resting models stay current.
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useLiveEvents((e) => {
    if (e.type === 'provider.updated') list.setData((d) => d && (d.some((p) => p.id === e.data.id) ? d.map((p) => (p.id === e.data.id ? e.data : p)) : [...d, e.data]));
  });

  const providers = list.data ?? [];
  const reorder = async (ids: string[]) => {
    const before = list.data;
    list.setData(ids.map((id) => providers.find((p) => p.id === id)!).filter(Boolean));
    try { await api.setProviderOrder(ids); } catch (e) { list.setData(before); toast((e as Error).message); }
  };
  const move = (id: string, by: number) => {
    const ids = providers.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };
  const dropOn = (target: string) => {
    if (!drag || drag === target) return;
    const ids = providers.map((p) => p.id).filter((x) => x !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    setDrag(null);
    reorder(ids);
  };
  const test = async (p: ModelProvider) => {
    setTests((t) => ({ ...t, [p.id]: 'running' }));
    try {
      const r = await api.testProvider(p.id);
      setTests((t) => ({ ...t, [p.id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, latencyMs: 0, error: (e as Error).message } }));
    }
  };
  const toggle = async (p: ModelProvider, enabled: boolean) => {
    try { const u = await api.updateProvider(p.id, { enabled }); list.setData((d) => d && d.map((x) => (x.id === u.id ? u : x))); } catch (e) { toast((e as Error).message); }
  };

  const own = (stars ?? []).filter((s) => s.providerIds && s.providerIds.length);
  const firstReady = providers.find((p) => p.enabled && p.health.state !== 'failing');

  return (
    <div className="page">
      <PageHead title="Models" sub="The brains your Stars think with. Sky tries them top to bottom, and moves on when one hits a limit, runs out of credit or breaks.">
        <button className="btn ink" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add a model</button>
      </PageHead>

      {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Skeleton h={76} n={3} /> : providers.length === 0 ? (
        <Empty title="No models yet" icon="bolt">Add one to get real answers. Several providers have free tiers, and Ollama runs models on your own computer.</Empty>
      ) : (
        <section>
          <div className="between" style={{ marginBottom: 10 }}>
            <div className="section-title" style={{ margin: 0 }}>Fallback order</div>
            {firstReady && <span className="t3 xs">Next answer comes from {firstReady.name}</span>}
          </div>
          <ol className="panel chain" aria-label="Fallback order">
            {providers.map((p, i) => {
              const t = tests[p.id];
              return (
                <li
                  key={p.id}
                  className={`chain-row ${drag === p.id ? 'dragging' : ''} ${p.enabled ? '' : 'off'}`}
                  draggable
                  onDragStart={(e) => { setDrag(p.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => dropOn(p.id)}
                  onDragEnd={() => setDrag(null)}
                >
                  <span className="grip" aria-hidden="true"><Icon name="menu" size={15} /></span>
                  <span className="rank">{i + 1}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <h3>{p.name}</h3>
                      {p.builtIn && <span className="chip">From the server</span>}
                      <HealthChip p={p} />
                    </div>
                    <p className="t3 xs mono-line"><span className="mono">{p.model}</span> · {KIND_LABEL[p.kind]}{p.hasKey && p.keyHint ? ` · key …${p.keyHint}` : !p.hasKey && !p.builtIn ? ' · no key' : ''}</p>
                    {p.enabled && p.health.lastError && p.health.state !== 'ok' && <p className="xs" style={{ color: p.health.state === 'failing' ? 'var(--danger)' : 'var(--warn)', marginTop: 2 }}>{p.health.lastError}{p.health.lastErrorAt ? ` · ${relTime(p.health.lastErrorAt)}` : ''}</p>}
                    {t && t !== 'running' && (
                      <p className="xs test-result" data-ok={t.ok} role="status">
                        {t.ok ? `Answered in ${(t.latencyMs / 1000).toFixed(1)}s: “${t.reply ?? ''}”` : `Didn’t work: ${t.error}`}
                      </p>
                    )}
                  </div>
                  <div className="row chain-actions">
                    <button className="icon-btn" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(p.id, -1)}><Icon name="up" size={15} /></button>
                    <button className="icon-btn" aria-label={`Move ${p.name} down`} disabled={i === providers.length - 1} onClick={() => move(p.id, 1)}><span style={{ display: 'inline-grid', transform: 'rotate(180deg)' }}><Icon name="up" size={15} /></span></button>
                    <button className="btn sm" onClick={() => test(p)} disabled={t === 'running'}>{t === 'running' ? 'Testing…' : 'Test'}</button>
                    <button className="btn sm quiet" onClick={() => setEditing(p)}>Edit</button>
                    <Switch label={`Use ${p.name}`} checked={p.enabled} onChange={(v) => toggle(p, v)} />
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="t3 xs" style={{ marginTop: 8 }}>Drag to reorder, or use the arrows. A model that hits a rate limit rests for a few minutes; one with a bad key rests until you fix it.</p>
        </section>
      )}

      {settings && settings.smallProviderIds !== undefined && providers.length > 0 && (
        <section>
          <div className="section-title">For small jobs</div>
          <div className="panel">
            <div className="rows">
              <div className="r">
                <div className="grow">
                  <h3>Writing lessons from your corrections</h3>
                  <p className="t3 xs">A small, fast model is plenty for this, and saves your bigger ones.</p>
                </div>
                <select
                  className="field select"
                  aria-label="Model for lessons"
                  value={settings.smallProviderIds?.[0] ?? ''}
                  onChange={async (e) => { try { setSettings(await api.updateSettings({ smallProviderIds: e.target.value ? [e.target.value] : null })); } catch (err) { toast((err as Error).message); } }}
                >
                  <option value="">The Star’s own models</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        </section>
      )}

      {stars && stars.length > 1 && (
        <section>
          <div className="section-title">Stars with their own order</div>
          <div className="panel">
            <div className="rows">
              {own.length === 0 && <div className="r t3">Every Star uses the order above. You can give one its own on its page.</div>}
              {own.map((s) => (
                <a key={s.id} className="r" href={href('stars', s.id)}>
                  <StarFace star={s} size={28} still />
                  <div className="grow">
                    <h3>{s.name}</h3>
                    <p className="t3 xs">{s.providerIds!.map((id) => providers.find((p) => p.id === id)?.name ?? 'a removed model').join(' → ')}</p>
                  </div>
                  <Icon name="chevron" size={16} />
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      {editing && (
        <ProviderForm
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => { list.setData((d) => d && (d.some((x) => x.id === p.id) ? d.map((x) => (x.id === p.id ? p : x)) : [...d, p])); setEditing(null); }}
          onDeleted={(id) => { list.setData((d) => d && d.filter((x) => x.id !== id)); setEditing(null); }}
        />
      )}
    </div>
  );
}

/** Add or edit a model. The key is write-only: it's sent, never shown again. */
function ProviderForm({ provider, onClose, onSaved, onDeleted }: { provider: ModelProvider | null; onClose: () => void; onSaved: (p: ModelProvider) => void; onDeleted: (id: string) => void }) {
  const toast = useToast();
  const presets = useResource(() => (provider ? Promise.resolve([] as ProviderPreset[]) : api.listProviderPresets()), []);
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [name, setName] = useState(provider?.name ?? '');
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [model, setModel] = useState(provider?.model ?? '');
  const [key, setKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(!provider?.hasKey);
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const builtIn = !!provider?.builtIn;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (p: ProviderPreset) => {
    setPreset(p);
    setName(p.name);
    setKind(p.kind);
    setBaseUrl(p.baseUrl);
    setModel(p.exampleModel);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let p: ModelProvider;
      if (builtIn) {
        p = await api.updateProvider(provider!.id, { name: name.trim() });
      } else {
        const body: Partial<ProviderInput> = { name: name.trim(), kind, baseUrl: baseUrl.trim(), model: model.trim() };
        if (key.trim()) body.apiKey = key.trim();
        else if (removeKey) body.apiKey = null;
        p = provider ? await api.updateProvider(provider.id, body) : await api.createProvider(body as ProviderInput);
      }
      setKey('');
      toast(provider ? 'Saved' : `${p.name} added to the end of the order`);
      onSaved(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!provider) return;
    try { await api.deleteProvider(provider.id); toast(`${provider.name} removed`); onDeleted(provider.id); } catch (e) { setError((e as Error).message); }
  };

  const valid = name.trim() && (builtIn || (baseUrl.trim() && model.trim()));

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg provider-form" role="dialog" aria-modal="true" aria-label={provider ? `Edit ${provider.name}` : 'Add a model'} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid) save(); }} autoComplete="off">
        <div className="between">
          <h2>{provider ? `Edit ${provider.name}` : 'Add a model'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>

        {!provider && (
          <div>
            <span className="label">Start from</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {!presets.data && <Skeleton h={32} n={1} />}
              {presets.data?.map((p) => (
                <button key={p.name} type="button" className={`idea-pill ${preset?.name === p.name ? 'on' : ''}`} onClick={() => pick(p)}>{p.name}</button>
              ))}
            </div>
            {preset?.note && <p className="t3 xs" style={{ marginTop: 8 }}>{preset.note}</p>}
          </div>
        )}

        {builtIn && <p className="t2" style={{ fontSize: 14 }}>This one comes from the server’s own key. You can rename it or turn it off, but not change it here.</p>}

        <div>
          <label className="label" htmlFor="pv-name">Name</label>
          <input id="pv-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Groq" autoFocus={!!provider} />
        </div>
        {!builtIn && (
          <>
            <div>
              <span className="label">Speaks</span>
              <Segmented<ProviderKind> label="API format" value={kind} onChange={setKind} options={[{ value: 'openai', label: KIND_LABEL.openai }, { value: 'anthropic', label: KIND_LABEL.anthropic }]} />
            </div>
            <div>
              <label className="label" htmlFor="pv-url">Base URL</label>
              <input id="pv-url" className="field mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={kind === 'openai' ? 'https://api.example.com/v1' : 'https://api.anthropic.com'} spellCheck={false} />
            </div>
            <div>
              <label className="label" htmlFor="pv-model">Model</label>
              <input id="pv-model" className="field mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama-3.3-70b-versatile" spellCheck={false} />
            </div>
            <div>
              <div className="between">
                <label className="label" htmlFor="pv-key">API key</label>
                {preset?.keyUrl && <a className="t3 xs" href={preset.keyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Get a key</a>}
              </div>
              {provider?.hasKey && !replacingKey ? (
                <div className="key-saved">
                  <Icon name="lock" size={15} />
                  <span className="grow">{removeKey ? 'The key will be removed when you save' : `A key is saved${provider.keyHint ? `, ending in ${provider.keyHint}` : ''}`}</span>
                  {!removeKey && <button type="button" className="btn sm" onClick={() => setReplacingKey(true)}>Replace</button>}
                  <button type="button" className="btn sm quiet" onClick={() => setRemoveKey((v) => !v)}>{removeKey ? 'Keep it' : 'Remove'}</button>
                </div>
              ) : (
                <input id="pv-key" className="field mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={preset && !preset.needsKey ? 'Not needed for this one' : provider?.hasKey ? 'Paste the new key' : 'Paste your key'} autoComplete="new-password" spellCheck={false} />
              )}
              <p className="t3 xs" style={{ marginTop: 6 }}>Keys are stored on your Sky server and never shown again, not even here.</p>
            </div>
          </>
        )}

        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {provider && !builtIn && <><button type="button" className="btn quiet danger" onClick={remove}><Icon name="trash" size={15} /> Remove</button><span className="grow" /></>}
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!valid || busy}>{busy ? 'Saving…' : provider ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
}
