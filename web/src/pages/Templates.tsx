import { useRef, useState } from 'react';
import { api, type StarTemplate, type StarView, type TemplateEntry } from '../api';
import { Icon } from '../components/Icon';
import { ErrorNote, PageHead, Skeleton, StarFace, useToast } from '../components/ui';
import { useAgent } from '../lib/agent';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';

/** Save a Star as a .sky-star.json file. Never includes memory, chats or secrets. */
export async function downloadTemplate(star: Pick<StarView, 'id' | 'name'>) {
  const t = await api.starTemplate(star.id);
  const blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${star.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'star'}.sky-star.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Start a Star from a template (built in, the gallery, a file or a link), or share one of yours. */
export function Templates() {
  const toast = useToast();
  const { stars, upsertStar, settings, setSettings } = useAgent();
  const list = useResource(() => api.listTemplates(), [settings?.templateGallery]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [repo, setRepo] = useState(settings?.templateGallery ?? '');
  const file = useRef<HTMLInputElement>(null);

  const done = (star: StarView, skipped: string[]) => {
    upsertStar(star);
    toast(skipped.length ? `${star.name} joined. Skipped ${skipped.join(', ')}, which ${skipped.length === 1 ? 'isn’t' : 'aren’t'} connected here.` : `${star.name} joined your constellation`);
    navigate('stars', star.id);
  };
  const run = async (key: string, from: Parameters<typeof api.importTemplate>[0]) => {
    setBusy(key);
    try { const r = await api.importTemplate(from); done(r.star, r.skipped); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  const fromFile = async (f: File) => {
    let template: StarTemplate;
    try { template = JSON.parse(await f.text()); } catch { toast('That file isn’t a Sky Star template'); return; }
    run('file', { template });
  };

  const builtIn = list.data?.templates.filter((t) => t.source === 'builtIn') ?? [];
  const gallery = list.data?.templates.filter((t) => t.source === 'gallery') ?? [];

  return (
    <div className="page">
      <a href={href('stars')} className="row t3"><Icon name="back" size={14} /> Constellation</a>
      <PageHead title="Templates" sub="Start a Star from someone’s recipe, or share one of yours. A template carries a Star’s role, instructions, style, look, apps, skills and rules. Never its memory, chats or secrets." />

      <section>
        <div className="section-title">Import</div>
        <div className="panel pad col">
          <div className="row wrap" style={{ gap: 8 }}>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ''; }} />
            <button className="btn" onClick={() => file.current?.click()} disabled={busy === 'file'}><Icon name="note" size={15} /> {busy === 'file' ? 'Importing…' : 'From a file'}</button>
            <span className="t3 xs">a .sky-star.json someone shared</span>
          </div>
          <form className="row wrap" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (/^https:\/\//.test(link.trim())) run('link', { url: link.trim() }); }}>
            <input className="field mono grow" style={{ minWidth: 220 }} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… link to a template" aria-label="Template link" spellCheck={false} />
            <button className="btn" disabled={!/^https:\/\//.test(link.trim()) || busy === 'link'}>{busy === 'link' ? 'Importing…' : 'Import'}</button>
          </form>
          <p className="t3 xs">Imported Stars get a name of their own if it’s taken, and skip apps you haven’t connected.</p>
        </div>
      </section>

      {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Skeleton h={110} n={2} /> : (
        <>
          <section>
            <div className="section-title">Built in</div>
            <div className="tpl-grid">{builtIn.map((t) => <TemplateCard key={t.id} t={t} busy={busy === t.id} onUse={() => run(t.id, { id: t.id })} />)}</div>
          </section>

          <section>
            <div className="between" style={{ marginBottom: 10 }}>
              <div className="section-title" style={{ margin: 0 }}>Gallery</div>
            </div>
            {list.data.galleryError && <p className="send-error" style={{ margin: '0 0 10px' }}>Couldn’t load the gallery: {list.data.galleryError}</p>}
            {gallery.length > 0 && <div className="tpl-grid" style={{ marginBottom: 12 }}>{gallery.map((t) => <TemplateCard key={t.id} t={t} busy={busy === t.id} onUse={() => run(t.id, { id: t.id })} />)}</div>}
            {settings && settings.templateGallery !== undefined && (
              <form className="panel pad col" onSubmit={async (e) => { e.preventDefault(); try { setSettings(await api.updateSettings({ templateGallery: repo.trim() })); toast(repo.trim() ? 'Gallery saved' : 'Gallery off'); } catch (err) { toast((err as Error).message); } }}>
                <label className="label" htmlFor="tpl-repo" style={{ margin: 0 }}>Gallery source</label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <input id="tpl-repo" className="field mono grow" style={{ minWidth: 200 }} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" spellCheck={false} />
                  <button className="btn" disabled={repo.trim() === (settings.templateGallery ?? '')}>Save</button>
                </div>
                <p className="t3 xs">A public GitHub repo with an index.json of templates, or a link to one. It’s free, and Sky checks every template it reads from it.</p>
              </form>
            )}
          </section>
        </>
      )}

      {stars && stars.length > 0 && stars[0].id && (
        <section>
          <div className="section-title">Share one of yours</div>
          <div className="panel">
            <div className="rows">
              {stars.map((s) => (
                <div key={s.id} className="r">
                  <StarFace star={s} size={28} still />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <h3>{s.name}</h3>
                    <p className="t3 xs">{s.role}</p>
                  </div>
                  <button className="btn sm" onClick={() => downloadTemplate(s).catch((e) => toast((e as Error).message))}>Download</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function TemplateCard({ t, busy, onUse }: { t: TemplateEntry; busy: boolean; onUse: () => void }) {
  const tp = t.template;
  return (
    <article className="panel tpl-card">
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <StarFace star={{ name: tp.name, avatar: tp.avatar }} size={40} still />
        <div className="grow" style={{ minWidth: 0 }}>
          <h3>{tp.name}</h3>
          <p className="t2" style={{ fontSize: 14 }}>{tp.role}</p>
        </div>
      </div>
      {tp.description && <p className="t3">{tp.description}</p>}
      <div className="row wrap" style={{ gap: 6 }}>
        {tp.apps?.length ? <span className="chip">{tp.apps.length} app{tp.apps.length === 1 ? '' : 's'}</span> : <span className="chip">{tp.apps === null ? 'All your apps' : 'No apps'}</span>}
        {tp.skills.length > 0 && <span className="chip">{tp.skills.length} skill{tp.skills.length === 1 ? '' : 's'}</span>}
        {tp.rules.length > 0 && <span className="chip">{tp.rules.length} rule{tp.rules.length === 1 ? '' : 's'}</span>}
      </div>
      <button className="btn sm ink" style={{ alignSelf: 'flex-start' }} onClick={onUse} disabled={busy}>{busy ? 'Adding…' : 'Use this'}</button>
    </article>
  );
}
