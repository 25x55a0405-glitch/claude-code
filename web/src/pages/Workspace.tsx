import { useEffect, useRef, useState } from 'react';
import { api, type TaskStep, type WorkspaceFile } from '../api';
import { Icon } from '../components/Icon';
import { Empty, ErrorNote, PageHead, Skeleton, StarFace, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { fileSize, relTime } from '../lib/format';
import { useLiveEvents, useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(txt|md|csv|json|log|py|js|ts|tsx|jsx|html|css|svg|xml|ya?ml|toml|sh|ini|env)$|^[^.]+$/i;
const baseName = (p: string) => p.split('/').pop() || p;

/**
 * Each Star's own computer: a folder that lasts between tasks, and the
 * terminal it runs commands in. You can look in, add files and take them out.
 */
export function Workspace({ starId }: { starId?: string }) {
  const { stars } = useAgent();
  const ws = useResource(() => api.getWorkspace(), []);
  const id = starId && stars?.some((s) => s.id === starId) ? starId : stars?.find((s) => s.id !== 'star_sky')?.id ?? stars?.[0]?.id;
  const star = stars?.find((s) => s.id === id);

  return (
    <div className="page wide">
      <PageHead title="Workspace" sub="Each Star has a folder of its own that lasts between tasks, and a terminal it runs commands in. Look in, add files, or take them out." />

      {stars && stars.length > 1 && (
        <div className="who-filter" role="group" aria-label="Whose workspace">
          {stars.map((s) => (
            <button key={s.id} aria-pressed={s.id === id} onClick={() => navigate('workspace', s.id)}><StarFace star={s} size={20} still />{s.name}</button>
          ))}
        </div>
      )}

      {ws.data && (
        ws.data.sandbox === 'bwrap' ? (
          <div className="sandbox-note ok">
            <Icon name="shield" size={16} />
            <p><strong>Sandboxed.</strong> Commands can only change this folder, have no internet unless they ask, and never see your server’s keys.</p>
          </div>
        ) : (
          <div className="sandbox-note warn" role="note">
            <Icon name="alert" size={16} />
            <p><strong>Not sandboxed.</strong> {ws.data.reason ?? 'Commands aren’t walled off here, so each one asks you first. On Linux, install bubblewrap.'}</p>
          </div>
        )
      )}

      {!stars ? <Skeleton h={220} /> : !star ? <Empty title="No Stars yet" /> : (
        <div className="ws-grid">
          <Files key={star.id} starId={star.id} starName={star.name} />
          <Terminal key={`t-${star.id}`} starId={star.id} starName={star.name} sandboxed={ws.data?.sandbox === 'bwrap'} />
        </div>
      )}
    </div>
  );
}

function Files({ starId, starName }: { starId: string; starName: string }) {
  const toast = useToast();
  const [path, setPath] = useState('');
  const list = useResource(() => api.listFiles(starId, path), [starId, path]);
  const [open, setOpen] = useState<WorkspaceFile | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useLiveEvents((e) => { if (e.type === 'workspace.changed' && e.data.starId === starId) list.reload(); });

  const upload = async (files: FileList | File[]) => {
    const all = [...files];
    if (!all.length) return;
    setUploading(all.length);
    let done = 0;
    for (const f of all) {
      try { await api.uploadFile(starId, path ? `${path}/${f.name}` : f.name, f); done++; } catch (e) { toast(`${f.name}: ${(e as Error).message}`); }
    }
    setUploading(0);
    if (done) toast(done === 1 ? `Added ${all[0].name}` : `Added ${done} files`);
    list.reload();
  };
  const remove = async (f: WorkspaceFile) => {
    try { await api.deleteFile(starId, f.path); toast(`Deleted ${baseName(f.path)}`); setConfirm(null); list.reload(); } catch (e) { toast((e as Error).message); }
  };

  const crumbs = path ? path.split('/') : [];
  const files = list.data?.files ?? [];

  return (
    <section
      className={`panel ws-files ${drag ? 'drag' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
    >
      <div className="ws-head">
        <nav className="crumbs" aria-label="Folder">
          <button className={!path ? 'on' : ''} onClick={() => setPath('')}><Icon name="folder" size={15} /> {starName}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <Icon name="chevron" size={12} />
              <button className={i === crumbs.length - 1 ? 'on' : ''} onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </nav>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
        <button className="btn sm" onClick={() => input.current?.click()} disabled={uploading > 0}><Icon name="upload" size={14} /> {uploading ? 'Adding…' : 'Add files'}</button>
      </div>

      {list.error ? <div className="pad"><ErrorNote error={list.error} retry={list.reload} /></div> : !list.data ? <div className="pad"><Skeleton h={36} n={4} /></div> : files.length === 0 ? (
        <div className="ws-empty">
          <Icon name="folder" size={22} />
          <p>{path ? 'This folder is empty.' : `${starName}’s folder is empty. Files it makes land here, and you can drop files in for it to work on.`}</p>
        </div>
      ) : (
        <div className="rows">
          {files.map((f) => {
            const name = baseName(f.path);
            return (
              <div key={f.path} className="r ws-row">
                <button className="ws-open" onClick={() => (f.kind === 'folder' ? setPath(f.path) : setOpen(f))}>
                  <span className={`glyph ${f.kind === 'folder' ? 'folder' : ''}`}><Icon name={f.kind === 'folder' ? 'folder' : 'note'} size={16} /></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="nm">{name}</span>
                    <span className="t3 xs">{f.kind === 'folder' ? 'Folder' : fileSize(f.size)} · {relTime(f.updatedAt)}</span>
                  </span>
                </button>
                {confirm === f.path ? (
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm danger" onClick={() => remove(f)}>Delete{f.kind === 'folder' ? ' folder' : ''}</button>
                    <button className="btn sm quiet" onClick={() => setConfirm(null)}>Keep</button>
                  </div>
                ) : (
                  <div className="row ws-actions" style={{ gap: 2 }}>
                    {f.kind === 'file' && <a className="icon-btn" href={api.fileUrl(starId, f.path, true)} download={name} aria-label={`Download ${name}`} title="Download"><Icon name="download" size={16} /></a>}
                    <button className="icon-btn" onClick={() => setConfirm(f.path)} aria-label={`Delete ${name}`} title="Delete"><Icon name="trash" size={16} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="ws-foot t3 xs">
        <span>{list.data ? `${fileSize(list.data.usage)} used` : ' '}</span>
        <span>Drop files here · up to 10 MB each</span>
      </div>
      {open && <Preview starId={starId} file={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Preview({ starId, file, onClose }: { starId: string; file: WorkspaceFile; onClose: () => void }) {
  const name = baseName(file.path);
  const image = IMAGE.test(name);
  const text = !image && TEXT.test(name);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!text) return;
    let live = true;
    fetch(api.fileUrl(starId, file.path), { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Couldn’t open it (${r.status})`))))
      .then((t) => { if (live) setBody(t.length > 200_000 ? `${t.slice(0, 200_000)}\n\n… cut off here. Download it to see the rest.` : t); }, (e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [starId, file.path, text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal file-preview" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => e.stopPropagation()}>
        <div className="between">
          <div style={{ minWidth: 0 }}>
            <h2 className="mono" style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{file.path}</h2>
            <p className="t3 xs">{fileSize(file.size)} · changed {relTime(file.updatedAt)}</p>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <a className="btn sm" href={api.fileUrl(starId, file.path, true)} download={name}><Icon name="download" size={14} /> Download</a>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
        </div>
        {image ? <img className="preview-img" src={api.fileUrl(starId, file.path)} alt={name} />
          : !text ? <p className="t3">No preview for this kind of file. Download it to open it.</p>
          : error ? <p className="send-error" style={{ margin: 0 }}>{error}</p>
          : body === null ? <Skeleton h={160} />
          : <pre className="file-body">{body || '(empty)'}</pre>}
      </div>
    </div>
  );
}

type Run = { id: string; at: string; taskId: string; taskTitle: string; command: string; status: string | null; output?: string };

const RAN = /^Ran `([\s\S]*)`(?: \((.+)\))?$/;

/** The commands a Star ran, newest last, read from its goals' steps. You watch; the Star types. */
function Terminal({ starId, starName, sandboxed }: { starId: string; starName: string; sandboxed: boolean }) {
  const runs = useResource(async () => {
    const tasks = (await api.listTasks({ starId })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
    const details = await Promise.all(tasks.map((t) => api.getTask(t.id).catch(() => null)));
    const out: Run[] = [];
    for (const d of details) {
      if (!d) continue;
      for (const s of d.steps) { const r = toRun(s, d.id, d.title); if (r) out.push(r); }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-40);
  }, [starId]);
  const body = useRef<HTMLDivElement>(null);

  useLiveEvents((e) => { if (e.type === 'task.step' && RAN.test(e.data.step.summary)) runs.reload(); });
  // Newest at the bottom, like a terminal; scroll the log, never the page.
  useEffect(() => { const el = body.current; if (el) el.scrollTop = el.scrollHeight; }, [runs.data?.length]);

  return (
    <section className="terminal" aria-label={`${starName}’s terminal`}>
      <div className="term-head">
        <span className="dots"><i /><i /><i /></span>
        <span className="grow">{starName.toLowerCase()}@sky: /workspace</span>
        <span className="term-tag"><Icon name={sandboxed ? 'shield' : 'alert'} size={12} /> {sandboxed ? 'sandboxed' : 'asks first'}</span>
      </div>
      <div className="term-body" role="log" ref={body}>
        {runs.error ? <p className="term-dim">Couldn’t load the commands. {runs.error.message}</p>
          : !runs.data ? <p className="term-dim">Loading…</p>
          : runs.data.length === 0 ? <p className="term-dim">{starName} hasn’t run any commands yet. When a goal needs one (a script, a conversion, a quick calculation), it shows up here with its output.</p>
          : runs.data.map((r) => (
            <div key={r.id} className="term-run">
              <div className="term-cmd">
                <span className="term-prompt">$</span>
                <span className="grow">{r.command}</span>
                {r.status ? <span className={`term-exit ${r.status === 'exit 0' ? 'ok' : 'bad'}`}>{r.status}</span> : <span className="term-exit run">running</span>}
              </div>
              {r.output && <pre>{r.output}</pre>}
              <a className="term-meta" href={href('goals', r.taskId)}>{r.taskTitle} · {relTime(r.at)}</a>
            </div>
          ))}
      </div>
      <p className="term-foot">Only {starName} types here. Commands run in its folder{sandboxed ? ', walled off from the rest of the server' : ''}, and each one shows on its goal too.</p>
    </section>
  );
}

function toRun(s: TaskStep, taskId: string, taskTitle: string): Run | null {
  const m = RAN.exec(s.summary);
  if (!m) return null;
  return { id: s.id, at: s.at, taskId, taskTitle, command: m[1], status: m[2] ?? null, output: s.detail?.trim() || undefined };
}
