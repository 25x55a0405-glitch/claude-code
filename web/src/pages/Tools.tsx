import { useEffect, useState } from 'react';
import { api, type McpInput, type McpServer, type StarView, type ToolEffect } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Segmented, Skeleton, StarFace, Switch, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href } from '../lib/router';

const EFFECTS: { value: ToolEffect; label: string }[] = [
  { value: 'read', label: 'Looks only' },
  { value: 'write', label: 'Changes things' },
  { value: 'send', label: 'Sends' },
  { value: 'delete', label: 'Deletes' },
  { value: 'spend', label: 'Spends money' },
];

const STATUS = {
  ready: { cls: 'ok', label: 'Ready' },
  connecting: { cls: '', label: 'Connecting' },
  error: { cls: 'danger', label: 'Needs fixing' },
  off: { cls: '', label: 'Off' },
} as const;

/** MCP servers: extra tools for the Stars, run on the Sky server or hosted elsewhere. */
export function Tools() {
  const toast = useToast();
  const { stars, upsertStar } = useAgent();
  const list = useResource(() => api.listMcp(), []);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useLiveEvents((e) => {
    if (e.type === 'mcp.updated') list.setData((d) => d && (d.some((m) => m.id === e.data.id) ? d.map((m) => (m.id === e.data.id ? e.data : m)) : [...d, e.data]));
    if (e.type === 'mcp.deleted') list.setData((d) => d && d.filter((m) => m.id !== e.data.id));
  });
  const replace = (m: McpServer) => list.setData((d) => d && d.map((x) => (x.id === m.id ? m : x)));
  const servers = list.data ?? [];

  const gets = (s: StarView, id: string) => s.mcpServerIds == null || s.mcpServerIds.includes(id);
  const toggleStar = async (s: StarView, id: string) => {
    const cur = s.mcpServerIds ?? servers.map((m) => m.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    try { upsertStar(await api.updateStar(s.id, { mcpServerIds: next })); } catch (e) { toast((e as Error).message); }
  };
  const setEffect = async (m: McpServer, tool: string, effect: ToolEffect) => {
    try { replace(await api.updateMcp(m.id, { toolEffects: { ...m.toolEffects, [tool]: effect } })); } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="page">
      <PageHead title="Tools" sub="Give your Stars more to work with through MCP servers, like your files, Linear or a database. How often they ask first follows each tool’s effect and each Star’s independence.">
        <button className="btn ink" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add a server</button>
      </PageHead>

      {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Skeleton h={90} n={2} /> : servers.length === 0 ? (
        <Empty title="No tool servers yet" icon="plug">Add an MCP server that runs here, such as the filesystem server, or a hosted one by its URL. Many are free and open source.</Empty>
      ) : (
        <div className="col">
          {servers.map((m) => {
            const st = STATUS[m.enabled ? m.status : 'off'];
            const expanded = open === m.id;
            return (
              <article key={m.id} className="panel mcp-card">
                <div className="row" style={{ gap: 12, padding: '16px 16px 0' }}>
                  <span className="glyph"><Icon name="plug" size={16} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <h3>{m.name}</h3>
                      <span className={`chip ${st.cls}`}><span className="dot" />{st.label}</span>
                      <span className="chip">{m.transport === 'stdio' ? 'On this server' : 'Hosted'}</span>
                    </div>
                    <p className="t3 xs mono-line"><span className="mono">{m.transport === 'stdio' ? [m.command, ...m.args].join(' ') : m.url}</span></p>
                  </div>
                  <Switch label={`Use ${m.name}`} checked={m.enabled} onChange={async (enabled) => { try { replace(await api.updateMcp(m.id, { enabled })); } catch (e) { toast((e as Error).message); } }} />
                </div>
                {m.enabled && m.error && <p className="xs" style={{ color: 'var(--danger)', padding: '6px 16px 0 62px' }}>{m.error}</p>}

                <div className="mcp-body">
                  {stars && stars.length > 1 && (
                    <div className="row wrap" style={{ gap: 8 }}>
                      <span className="t3 xs" style={{ minWidth: 70 }}>Who gets it</span>
                      <div className="who-filter" role="group" aria-label={`Stars that get ${m.name}`}>
                        {stars.map((s) => (
                          <button key={s.id} aria-pressed={gets(s, m.id)} onClick={() => toggleStar(s, m.id)}><StarFace star={s} size={18} still />{s.name}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="row wrap" style={{ gap: 8 }}>
                    <span className="t3 xs" style={{ minWidth: 70 }}>Tools</span>
                    <span className="grow t2" style={{ fontSize: 14 }}>
                      {m.tools.length ? `${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}, ${m.tools.filter((t) => (m.toolEffects[t.name] ?? t.effect) === 'read').length} look only` : m.status === 'connecting' ? 'Finding its tools…' : 'None yet'}
                    </span>
                    {m.tools.length > 0 && <button className="btn sm quiet" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : m.id)}>{expanded ? 'Hide' : 'Set what needs approval'}</button>}
                    {m.status === 'error' && <button className="btn sm" onClick={async () => { try { replace(await api.reconnectMcp(m.id)); } catch (e) { toast((e as Error).message); } }}>Try again</button>}
                    <button className="btn sm quiet" onClick={() => setEditing(m)}>Edit</button>
                  </div>
                  {expanded && (
                    <div className="tool-list">
                      {m.tools.map((t) => (
                        <div key={t.name} className="tool-row">
                          <div className="grow" style={{ minWidth: 0 }}>
                            <div className="mono" style={{ fontSize: 13 }}>{t.name}</div>
                            {t.description && <p className="t3 xs">{t.description}</p>}
                          </div>
                          <select className="field select" aria-label={`What ${t.name} does`} value={m.toolEffects[t.name] ?? t.effect} onChange={(e) => setEffect(m, t.name, e.target.value as ToolEffect)}>
                            {EFFECTS.map((ef) => <option key={ef.value} value={ef.value}>{ef.label}</option>)}
                          </select>
                        </div>
                      ))}
                      <p className="t3 xs">Look-only tools run without asking and can be used in chat. Everything else asks first, as set by each Star’s independence in <a href={href('permissions')} style={{ textDecoration: 'underline' }}>Permissions</a>, and only runs inside a goal.</p>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          <p className="t3 xs">Fewer tools per Star helps small free models pick the right one.</p>
        </div>
      )}

      {editing && <McpForm server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { list.setData((d) => d && (d.some((x) => x.id === m.id) ? d.map((x) => (x.id === m.id ? m : x)) : [...d, m])); setEditing(null); }} onDeleted={(id) => { list.setData((d) => d && d.filter((x) => x.id !== id)); setEditing(null); }} />}
    </div>
  );
}

type Pair = { key: string; value: string };

/** Variables or headers. Values go up once and never come back; a vault secret can stand in. */
function Pairs({ label, rows, onChange, secrets, keyHint }: { label: string; rows: Pair[]; onChange: (r: Pair[]) => void; secrets: string[]; keyHint: string }) {
  const set = (i: number, patch: Partial<Pair>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="col" style={{ gap: 8 }}>
      {rows.map((r, i) => {
        const fromVault = /^\{\{secret:([A-Za-z0-9_]+)\}\}$/.exec(r.value)?.[1];
        return (
          <div key={i} className="pair-row">
            <input className="field mono" aria-label={`${label} name`} value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder={keyHint} spellCheck={false} />
            {fromVault ? (
              <div className="key-saved grow"><Icon name="lock" size={14} /><span className="grow mono" style={{ fontSize: 12.5 }}>{fromVault}</span><button type="button" className="btn sm quiet" onClick={() => set(i, { value: '' })}>Type instead</button></div>
            ) : (
              <input className="field mono" type="password" autoComplete="new-password" aria-label={`${label} value`} value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="Value" spellCheck={false} />
            )}
            {secrets.length > 0 && !fromVault && (
              <select className="field select" aria-label="Use a secret" value="" onChange={(e) => e.target.value && set(i, { value: `{{secret:${e.target.value}}}` })}>
                <option value="">From vault…</option>
                {secrets.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
            <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={15} /></button>
          </div>
        );
      })}
      <button type="button" className="link-btn t3 xs" onClick={() => onChange([...rows, { key: '', value: '' }])}>Add {rows.length ? 'another' : 'one'}</button>
    </div>
  );
}

function McpForm({ server, onClose, onSaved, onDeleted }: { server: McpServer | null; onClose: () => void; onSaved: (m: McpServer) => void; onDeleted: (id: string) => void }) {
  const toast = useToast();
  const vault = useResource(() => api.listSecrets().then((r) => r.secrets.map((s) => s.name)).catch(() => [] as string[]), []);
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server ? [server.command, ...server.args].filter(Boolean).join(' ') : '');
  const [url, setUrl] = useState(server?.url ?? '');
  const keysOnly = (keys: string[]) => keys.map((key) => ({ key, value: '' }));
  const [env, setEnv] = useState<Pair[]>(keysOnly(server?.envKeys ?? []));
  const [headers, setHeaders] = useState<Pair[]>(keysOnly(server?.headerKeys ?? []));
  // When editing, saved values stay unless the person chooses to replace them all.
  const [replacing, setReplacing] = useState(!server);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pairs = transport === 'stdio' ? env : headers;
  const toMap = (rows: Pair[]) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
  const missing = replacing && pairs.some((r) => r.key.trim() && !r.value);
  const valid = /^[a-z0-9_-]{1,32}$/i.test(name.trim()) && (transport === 'stdio' ? command.trim() : /^https?:\/\//.test(url.trim())) && !missing;

  const save = async () => {
    setBusy(true);
    setError(null);
    const [cmd, ...args] = command.trim().split(/\s+/);
    const body: Partial<McpInput> = { name: name.trim(), transport, ...(transport === 'stdio' ? { command: cmd, args } : { url: url.trim() }) };
    if (replacing) {
      if (transport === 'stdio') body.env = toMap(env);
      else body.headers = toMap(headers);
    }
    try {
      const m = server ? await api.updateMcp(server.id, body) : await api.createMcp(body as McpInput);
      toast(server ? 'Saved. Reconnecting' : `${m.name} added. Connecting`);
      onSaved(m);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { await api.deleteMcp(server!.id); toast(`${server!.name} removed`); onDeleted(server!.id); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg provider-form" role="dialog" aria-modal="true" aria-label={server ? `Edit ${server.name}` : 'Add a tool server'} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid) save(); }} autoComplete="off">
        <div className="between">
          <h2>{server ? `Edit ${server.name}` : 'Add a tool server'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div>
          <label className="label" htmlFor="mcp-name">Name</label>
          <input id="mcp-name" className="field mono" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '_'))} placeholder="files" spellCheck={false} autoFocus={!server} />
          <p className="t3 xs" style={{ marginTop: 6 }}>Short, with letters, digits, - or _. Stars see its tools as mcp_{name.trim() || 'name'}_….</p>
        </div>
        <div>
          <span className="label">Where it runs</span>
          <Segmented<'stdio' | 'http'> label="Where it runs" value={transport} onChange={setTransport} options={[{ value: 'stdio', label: 'On this server' }, { value: 'http', label: 'Hosted, by URL' }]} />
        </div>
        {transport === 'stdio' ? (
          <div>
            <label className="label" htmlFor="mcp-cmd">Command</label>
            <input id="mcp-cmd" className="field mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem /home/me/notes" spellCheck={false} />
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="mcp-url">URL</label>
            <input id="mcp-url" className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
          </div>
        )}
        <div>
          <div className="between">
            <span className="label">{transport === 'stdio' ? 'Environment variables' : 'Headers'}</span>
            {server && !replacing && pairs.length > 0 && <button type="button" className="btn sm quiet" onClick={() => { setReplacing(true); }}>Replace values</button>}
          </div>
          {server && !replacing ? (
            pairs.length ? (
              <div className="key-saved"><Icon name="lock" size={15} /><span className="grow mono" style={{ fontSize: 12.5 }}>{pairs.map((p) => p.key).join(', ')}</span><span className="t3 xs">values saved</span></div>
            ) : <button type="button" className="link-btn t3 xs" onClick={() => setReplacing(true)}>Add {transport === 'stdio' ? 'a variable' : 'a header'}</button>
          ) : (
            <Pairs label={transport === 'stdio' ? 'Variable' : 'Header'} rows={pairs} onChange={transport === 'stdio' ? setEnv : setHeaders} secrets={vault.data ?? []} keyHint={transport === 'stdio' ? 'API_KEY' : 'Authorization'} />
          )}
          <p className="t3 xs" style={{ marginTop: 6 }}>Values stay on your Sky server and aren’t shown again. Pick one from your vault to keep it there instead.{server && replacing ? ' Saving replaces all of them, so fill in every value.' : ''}</p>
        </div>
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {server && (confirm ? (
            <><button type="button" className="btn danger" onClick={remove}>Remove from every Star</button><button type="button" className="btn quiet" onClick={() => setConfirm(false)}>Keep</button><span className="grow" /></>
          ) : (
            <><button type="button" className="btn quiet danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Remove</button><span className="grow" /></>
          ))}
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!valid || busy}>{busy ? 'Saving…' : server ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
}
