import { useEffect, useState } from 'react';
import { api, type Autonomy, type AvatarCharacter, type AvatarColor, type Rule, type StarView } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { PageHead, Segmented, Skeleton, Switch, useToast } from '../components/ui';
import { starChat, useAgent } from '../lib/agent';
import { useResource } from '../lib/hooks';
import { href, navigate } from '../lib/router';
import { StarAddress } from '../components/StarAddress';
import { HealthChip } from './Models';
import { downloadTemplate } from './Templates';
import { LOGO } from './Permissions';

const CHARACTERS: AvatarCharacter[] = ['cloud', 'dot', 'drop'];
const COLORS: AvatarColor[] = ['sky', 'peach', 'mint', 'lilac', 'sun'];
const STYLES = [
  { label: 'Short and direct', text: 'Short. Lead with the answer, then one line of why. No emoji.' },
  { label: 'Bullet points', text: 'Use bullet points. Best option first, with prices and links.' },
  { label: 'Warm and chatty', text: 'Friendly and conversational, a couple of short paragraphs.' },
  { label: 'Just the facts', text: 'Facts only, no small talk. Numbers and dates up front.' },
];

const AUTONOMY: { value: Autonomy | null; title: string; body: string }[] = [
  { value: null, title: 'Same as you set', body: 'Follows the independence level in Permissions.' },
  { value: 'ask', title: 'Ask first', body: 'Checks with you before every action.' },
  { value: 'balanced', title: 'Balanced', body: 'Handles routine things, asks before sending, spending or deleting.' },
  { value: 'autonomous', title: 'Hands-off', body: 'Acts on its own and tells you after. Safety rules still apply.' },
];

/** Ready-made jobs for a new Star, so starting one is a tap. */
const TEMPLATES: { label: string; name: string; role: string; instructions: string; avatar: { character: AvatarCharacter; color: AvatarColor }; apps?: string[]; autonomy?: Autonomy }[] = [
  { label: 'Research', name: 'Scout', role: 'Researches trips, prices and places', instructions: 'Compare at least three sources and bring me the options with prices. Never book or pay.', avatar: { character: 'dot', color: 'mint' }, apps: ['web'], autonomy: 'ask' },
  { label: 'Inbox', name: 'Post', role: 'Looks after your inbox and replies', instructions: 'Keep my inbox at zero. Archive noise, draft replies in my voice, and ask before sending anything.', avatar: { character: 'drop', color: 'peach' }, apps: ['gmail'] },
  { label: 'Calendar', name: 'Tempo', role: 'Plans your week and protects your focus time', instructions: 'Keep mornings free for deep work. Suggest times, and ask before accepting or moving anything.', avatar: { character: 'cloud', color: 'lilac' }, apps: ['calendar'] },
  { label: 'Code', name: 'Patch', role: 'Watches your repos, reviews and builds', instructions: 'Tell me when a review or a failing build needs me. Summarise what changed.', avatar: { character: 'dot', color: 'sun' }, apps: ['github'] },
];

interface Draft {
  name: string;
  role: string;
  instructions: string;
  avatar: { character: AvatarCharacter; color: AvatarColor };
  autonomy: Autonomy | null;
  connectionIds: string[] | null;
  providerIds: string[] | null;
  personality: string;
  replyStyle: string;
  notify: { whenDone: boolean; whenNeedsYou: boolean };
}

const fromStar = (s: StarView): Draft => ({ name: s.name, role: s.role, instructions: s.instructions, avatar: s.avatar, autonomy: s.autonomy, connectionIds: s.connectionIds, providerIds: s.providerIds ?? null, personality: s.personality ?? '', replyStyle: s.replyStyle ?? '', notify: { whenDone: s.notify?.whenDone ?? false, whenNeedsYou: s.notify?.whenNeedsYou ?? true } });

export function StarEditor({ id }: { id: string }) {
  const isNew = id === 'new';
  const { stars, status, upsertStar } = useAgent();
  const toast = useToast();
  const star = isNew ? null : stars?.find((s) => s.id === id) ?? null;
  const conns = useResource(() => api.listConnections(), []);
  const models = useResource(() => api.listProviders(), [], ['provider.updated', 'provider.deleted']);
  const rules = useResource(() => (isNew ? Promise.resolve([] as Rule[]) : api.listRules(id)), [id]);
  const [draft, setDraft] = useState<Draft | null>(isNew ? { name: '', role: '', instructions: '', avatar: { character: 'dot', color: COLORS[(stars?.length ?? 1) % COLORS.length] }, autonomy: null, connectionIds: null, providerIds: null, personality: '', replyStyle: '', notify: { whenDone: false, whenNeedsYou: true } } : null);
  const [newRules, setNewRules] = useState<string[]>([]);
  const [ruleText, setRuleText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Load an existing Star into the form once it's known.
  useEffect(() => {
    if (!isNew && star && !draft) setDraft(fromStar(star));
  }, [isNew, star, draft]);

  if (!isNew && stars && !star) {
    return <div className="page"><PageHead title="That Star is gone" sub="It may have been removed on another device." /><a className="btn" href={href('stars')}>See your constellation</a></div>;
  }
  if (!draft) return <div className="page"><Skeleton h={180} n={2} /></div>;

  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setError(null); };
  const connected = (conns.data ?? []).filter((c) => c.status !== 'disconnected');
  const own = (rules.data ?? []).filter((r) => r.starId === id);
  const shared = (rules.data ?? []).filter((r) => !r.starId).length;
  const dirty = isNew || (star && JSON.stringify(fromStar(star)) !== JSON.stringify(draft));
  const canSave = draft.name.trim() && draft.role.trim() && dirty && !busy && !(draft.providerIds && draft.providerIds.length === 0);

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    const taken = stars?.some((s) => s.name.toLowerCase() === t.name.toLowerCase());
    const apps = t.apps?.filter((a) => connected.some((c) => c.id === a));
    set({ name: taken ? '' : t.name, role: t.role, instructions: t.instructions, avatar: t.avatar, autonomy: t.autonomy ?? null, connectionIds: apps && apps.length ? apps : null });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { ...draft, name: draft.name.trim(), role: draft.role.trim(), instructions: draft.instructions.trim(), personality: draft.personality.trim(), replyStyle: draft.replyStyle.trim() };
    try {
      if (isNew) {
        const s = await api.createStar(body);
        upsertStar(s);
        const failed: string[] = [];
        for (const text of newRules) await api.addRule(text, s.id).catch(() => failed.push(text));
        toast(failed.length ? `${s.name} joined, but ${failed.length === 1 ? 'a rule' : `${failed.length} rules`} didn’t save. Add ${failed.length === 1 ? 'it' : 'them'} again on its page.` : `${s.name} joined your constellation`);
        window.location.hash = starChat(s);
      } else {
        const s = await api.updateStar(id, body);
        upsertStar(s);
        setDraft(fromStar(s));
        toast('Saved');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    const text = ruleText.trim();
    if (!text) return;
    if (isNew) setNewRules((r) => [...r, text]);
    else {
      try { const r = await api.addRule(text, id); rules.setData((d) => [...(d ?? []), r]); } catch (e) { toast((e as Error).message); return; }
    }
    setRuleText('');
  };

  const remove = async () => {
    try {
      await api.deleteStar(id);
      toast(`${star?.name} was removed`);
      navigate('stars');
    } catch (e) {
      toast((e as Error).message);
      setConfirm(false);
    }
  };

  const pause = async () => {
    if (!star) return;
    try { upsertStar(await api.pauseStar(id, !star.paused)); } catch (e) { toast((e as Error).message); }
  };

  const toggleApp = (cid: string, on: boolean) => {
    const cur = draft.connectionIds ?? [];
    set({ connectionIds: on ? [...cur, cid] : cur.filter((x) => x !== cid) });
  };

  return (
    <div className="page">
      <PageHead title={isNew ? 'New Star' : draft.name || 'Your Star'} sub={isNew ? 'Give one job its own Star. It gets its own chat, apps and rules, and works with your other Stars.' : star?.main ? 'Your main Star. It talks with you first and passes work to the others.' : 'What it does, what it may use, and how far it can go on its own.'}>
        {!isNew && <a className="btn" href={star ? starChat(star) : href('chat')}><Icon name="chat" size={15} /> Open chat</a>}
      </PageHead>

      {isNew && (
        <section>
          <div className="section-title">Start from</div>
          <div className="row wrap">
            {TEMPLATES.map((t) => (
              <button key={t.label} className="idea-pill" onClick={() => applyTemplate(t)}>
                <Avatar size={20} character={t.avatar.character} color={t.avatar.color} label={t.name} />
                {t.label}
              </button>
            ))}
            <a className="idea-pill" href={href('stars', 'templates')}>More templates, or import one <Icon name="chevron" size={13} /></a>
          </div>
        </section>
      )}

      <section className="panel studio">
        <div className="studio-stage"><Avatar size={120} track state={star?.status.state === 'paused' || status?.state === 'paused' ? 'paused' : 'idle'} character={draft.avatar.character} color={draft.avatar.color} label={draft.name || 'New Star'} /></div>
        <div className="col-lg">
          <div>
            <label className="label" htmlFor="star-name">Name</label>
            <input id="star-name" className="field" maxLength={40} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Scout, Post, Tempo…" autoFocus={isNew} />
          </div>
          <div>
            <span className="label">Character</span>
            <div className="pick">
              {CHARACTERS.map((c) => (
                <button key={c} type="button" aria-pressed={draft.avatar.character === c} aria-label={c} title={c} onClick={() => set({ avatar: { ...draft.avatar, character: c } })}>
                  <Avatar size={36} character={c} color={draft.avatar.color} label={c} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Colour</span>
            <div className="row" style={{ gap: 10 }}>
              {COLORS.map((c) => (
                <button key={c} type="button" className="swatch" data-av={c} aria-pressed={draft.avatar.color === c} aria-label={c} onClick={() => set({ avatar: { ...draft.avatar, color: c } })} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">Its job</div>
        <div className="panel pad col">
          <div>
            <label className="label" htmlFor="star-role">Role</label>
            <input id="star-role" className="field" maxLength={120} value={draft.role} onChange={(e) => set({ role: e.target.value })} placeholder="One line, like “Researches trips, prices and places”" />
          </div>
          <div>
            <label className="label" htmlFor="star-instructions">Instructions</label>
            <textarea id="star-instructions" className="field" rows={4} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="Standing orders. How it should work, what to always or never do." />
          </div>
          {star && star.email !== undefined && (
            <div>
              <span className="label">Its email address</span>
              <StarAddress star={star} />
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="section-title">Personality</div>
        <div className="panel pad col">
          <div>
            <div className="between"><label className="label" htmlFor="star-personality">Its character</label><span className="t3 xs">{draft.personality.length}/1000</span></div>
            <textarea id="star-personality" className="field" rows={2} maxLength={1000} value={draft.personality} onChange={(e) => set({ personality: e.target.value })} placeholder="Calm and a little dry. Curious. Never pushy." />
          </div>
          <div>
            <div className="between"><label className="label" htmlFor="star-style">How it replies</label><span className="t3 xs">{draft.replyStyle.length}/1000</span></div>
            <textarea id="star-style" className="field" rows={2} maxLength={1000} value={draft.replyStyle} onChange={(e) => set({ replyStyle: e.target.value })} placeholder="Length, format, emoji or not." />
            <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
              {STYLES.map((st) => (
                <button key={st.label} type="button" className={`idea-pill sm ${draft.replyStyle === st.text ? 'on' : ''}`} onClick={() => set({ replyStyle: st.text })}>{st.label}</button>
              ))}
            </div>
          </div>
          <p className="t3 xs">You can also just tell {draft.name || 'it'} in chat, like “be more brief”, and it updates this itself.</p>
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="rows">
            <div className="r">
              <div className="grow"><h3>Ping me when it finishes something</h3><p className="t3 xs">On your phone or this browser, if you’ve set them up in Settings.</p></div>
              <Switch label="Ping me when it finishes something" checked={draft.notify.whenDone} onChange={(v) => set({ notify: { ...draft.notify, whenDone: v } })} />
            </div>
            <div className="r">
              <div className="grow"><h3>Ping me when it needs me</h3><p className="t3 xs">Approvals, questions and anything it’s stuck on.</p></div>
              <Switch label="Ping me when it needs me" checked={draft.notify.whenNeedsYou} onChange={(v) => set({ notify: { ...draft.notify, whenNeedsYou: v } })} />
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="section-title">Independence</div>
        <div className="autonomy four">
          {AUTONOMY.map((a) => (
            <button key={String(a.value)} type="button" aria-pressed={draft.autonomy === a.value} onClick={() => set({ autonomy: a.value })}>
              <h3>{a.title}</h3>
              <span>{a.body}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="between" style={{ marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Apps</div>
          <Segmented label="Which apps" value={draft.connectionIds === null ? 'all' : 'some'} onChange={(v) => set({ connectionIds: v === 'all' ? null : (draft.connectionIds ?? []) })} options={[{ value: 'all', label: 'All your apps' }, { value: 'some', label: 'Only these' }]} />
        </div>
        <div className="panel">
          <div className="rows">
            {!conns.data && <div className="r"><Skeleton h={30} n={2} /></div>}
            {conns.data && connected.length === 0 && <div className="r t3">No apps connected yet. Connect them in <a href={href('permissions')} style={{ textDecoration: 'underline' }}>Permissions</a>.</div>}
            {connected.map((c) => {
              const on = draft.connectionIds === null || draft.connectionIds.includes(c.id);
              return (
                <div key={c.id} className="r">
                  <div className="app-logo" style={{ background: LOGO[c.provider] ?? '#6b7280' }}>{c.name[0]}</div>
                  <div className="grow">
                    <h3>{c.name}</h3>
                    <p className="t3 xs">{c.access === 'read' ? 'Look only' : 'Look and act'}</p>
                  </div>
                  <Switch label={`${draft.name || 'This Star'} can use ${c.name}`} checked={on} disabled={draft.connectionIds === null} onChange={(v) => toggleApp(c.id, v)} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {models.data && models.data.length > 0 && (() => {
        const own = draft.providerIds;
        const byId = new Map(models.data.map((p) => [p.id, p]));
        const chosen = (own ?? []).filter((x) => byId.has(x));
        const rest = models.data.filter((p) => !chosen.includes(p.id));
        const move = (i: number, by: number) => {
          const ids = [...chosen];
          [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
          set({ providerIds: ids });
        };
        return (
          <section>
            <div className="between" style={{ marginBottom: 10 }}>
              <div className="section-title" style={{ margin: 0 }}>Models</div>
              <Segmented label="Which models" value={own === null ? 'all' : 'own'} onChange={(v) => set({ providerIds: v === 'all' ? null : models.data!.filter((p) => p.enabled).map((p) => p.id) })} options={[{ value: 'all', label: 'Same as everyone' }, { value: 'own', label: 'Its own order' }]} />
            </div>
            {own === null ? (
              <p className="t3">{draft.name || 'This Star'} uses the <a href={href('models')} style={{ textDecoration: 'underline' }}>fallback order in Models</a>{models.data[0] ? `, starting with ${models.data.find((p) => p.enabled)?.name ?? models.data[0].name}` : ''}.</p>
            ) : (
              <ol className="panel chain" aria-label={`${draft.name || 'This Star'}’s model order`}>
                {chosen.map((pid, i) => {
                  const p = byId.get(pid)!;
                  return (
                    <li key={pid} className="chain-row">
                      <span className="rank">{i + 1}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="row wrap" style={{ gap: 6 }}><h3>{p.name}</h3><HealthChip p={p} /></div>
                        <p className="t3 xs"><span className="mono">{p.model}</span></p>
                      </div>
                      <div className="row chain-actions">
                        <button className="icon-btn" aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={15} /></button>
                        <button className="icon-btn" aria-label={`Move ${p.name} down`} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}><span style={{ display: 'inline-grid', transform: 'rotate(180deg)' }}><Icon name="up" size={15} /></span></button>
                        <Switch label={`${draft.name || 'This Star'} uses ${p.name}`} checked onChange={() => set({ providerIds: chosen.filter((x) => x !== pid) })} />
                      </div>
                    </li>
                  );
                })}
                {rest.map((p) => (
                  <li key={p.id} className="chain-row off">
                    <span className="rank">·</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row wrap" style={{ gap: 6 }}><h3>{p.name}</h3><HealthChip p={p} /></div>
                      <p className="t3 xs"><span className="mono">{p.model}</span></p>
                    </div>
                    <Switch label={`${draft.name || 'This Star'} uses ${p.name}`} checked={false} onChange={() => set({ providerIds: [...chosen, p.id] })} />
                  </li>
                ))}
              </ol>
            )}
            {own !== null && chosen.length === 0 && <p className="send-error" style={{ marginTop: 8 }}>Pick at least one model, or switch back to “Same as everyone”.</p>}
          </section>
        );
      })()}

      <section>
        <div className="section-title">Its own rules</div>
        <div className="panel">
          <div className="rows">
            {own.map((r) => (
              <div key={r.id} className="r">
                <p className="grow" style={{ opacity: r.enabled ? 1 : 0.5 }}>{r.text}</p>
                <button className="icon-btn" aria-label="Delete rule" onClick={async () => { await api.deleteRule(r.id); rules.setData((d) => d && d.filter((x) => x.id !== r.id)); }}><Icon name="trash" size={16} /></button>
                <Switch label={r.text} checked={r.enabled} onChange={async (enabled) => { const u = await api.updateRule(r.id, { enabled }); rules.setData((d) => d && d.map((x) => (x.id === r.id ? u : x))); }} />
              </div>
            ))}
            {newRules.map((t, i) => (
              <div key={i} className="r">
                <p className="grow">{t}</p>
                <button className="icon-btn" aria-label="Remove rule" onClick={() => setNewRules((r) => r.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
              </div>
            ))}
            <form className="r" onSubmit={(e) => { e.preventDefault(); addRule(); }}>
              <input className="grow" style={{ border: 'none', outline: 'none', background: 'transparent', padding: '6px 0' }} value={ruleText} onChange={(e) => setRuleText(e.target.value)} placeholder="Add a rule just for this Star" aria-label="New rule for this Star" />
              <button className="btn sm" disabled={!ruleText.trim()}>Add</button>
            </form>
          </div>
        </div>
        <p className="t3 xs" style={{ marginTop: 8 }}>
          It also follows {isNew ? 'the' : shared} rules every Star shares, in <a href={href('permissions')} style={{ textDecoration: 'underline' }}>Permissions</a>.
        </p>
      </section>

      {error && <p className="send-error" role="alert" style={{ alignSelf: 'flex-start' }}>{error}</p>}

      <div className="save-bar">
        <button className="btn ink lg" onClick={save} disabled={!canSave}>{busy ? 'Saving…' : isNew ? 'Add to constellation' : 'Save changes'}</button>
        {isNew ? (
          <a className="btn quiet lg" href={href('stars')}>Cancel</a>
        ) : (
          <>
            {stars && stars.length > 1 && (
              <button className="btn lg" onClick={pause} disabled={status?.state === 'paused'}>
                <Icon name={star?.paused ? 'play' : 'pause'} size={15} />{star?.paused ? `Wake ${star.name}` : `Pause ${star?.name}`}
              </button>
            )}
            {star && <button className="btn quiet lg" onClick={() => downloadTemplate(star).then(() => toast('Template saved. It has no memory, chats or secrets.'), (e) => toast((e as Error).message))} title="Download as a template to share">Share as template</button>}
            <span className="grow" />
            {!star?.main && <button className="btn quiet danger lg" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Remove</button>}
          </>
        )}
      </div>

      {confirm && star && (
        <div className="modal-scrim" onClick={() => setConfirm(false)}>
          <div className="modal col" role="dialog" aria-modal="true" aria-label={`Remove ${star.name}`} onClick={(e) => e.stopPropagation()}>
            <h2>Remove {star.name}?</h2>
            <p className="t2">Its unfinished goals stop, anything waiting for your OK expires, and its own memory, rules and chats are deleted. Finished work stays in Activity.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirm(false)}>Keep {star.name}</button>
              <button className="btn ink" style={{ background: 'var(--danger)' }} onClick={remove}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
