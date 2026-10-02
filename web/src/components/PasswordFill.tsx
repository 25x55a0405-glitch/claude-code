import { useEffect, useState } from 'react';
import { api, type SavedLogin } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { hostOf } from './BrowserView';
import { Icon } from './Icon';
import { ErrorNote, Skeleton, StarFace, Switch, useToast } from './ui';

/**
 * Password fill, off by default. Saved logins are write-only: the password
 * goes in and never comes back, to this screen or to any Star's model.
 */
export function PasswordFill() {
  const toast = useToast();
  const { settings, setSettings, stars } = useAgent();
  const list = useResource(() => api.listLogins(), [settings?.passwordFill]);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);
  const on = settings?.passwordFill === true;

  const turnOff = async () => {
    try { setSettings(await api.updateSettings({ passwordFill: false })); toast('Password fill off'); } catch (e) { toast((e as Error).message); }
  };
  const replace = (l: SavedLogin) => list.setData((d) => d && { ...d, logins: d.logins.map((x) => (x.id === l.id ? l : x)) });
  const starNames = (ids: string[] | null) => (ids === null ? 'Every Star' : ids.map((id) => stars?.find((s) => s.id === id)?.name ?? 'a Star').join(', '));

  return (
    <section>
      <div className="section-title">Signing in</div>
      <div className="panel">
        <div className="rows">
          <div className="r">
            <span className="glyph"><Icon name="key" size={16} /></span>
            <div className="grow">
              <h3>Let Stars sign in with saved logins</h3>
              <p className="t3 xs">{on ? 'On. A Star can fill a saved login on its own site, and asks you first each time unless you said not to.' : 'Off. When a site needs a sign-in, the Star asks you to take over the browser and do it yourself.'}</p>
            </div>
            <span className={`chip ${on ? 'warn' : ''}`}>{on ? 'On' : 'Off'}</span>
            <Switch label="Let Stars sign in with saved logins" checked={on} onChange={(v) => (v ? setConfirming(true) : turnOff())} />
          </div>

          {list.error ? <div className="r"><ErrorNote error={list.error} retry={list.reload} /></div> : !list.data ? <div className="r"><Skeleton h={30} n={2} /></div> : list.data.logins.map((l) => (
            <LoginRow key={l.id} login={l} on={on} who={starNames(l.starIds)} onChange={replace} onDelete={() => list.setData((d) => d && { ...d, logins: d.logins.filter((x) => x.id !== l.id) })} />
          ))}
          <div className="r">
            <p className="grow t3 xs">{list.data?.logins.length ? 'Passwords are encrypted on your Sky server and never shown again.' : 'No saved logins. Add one for a site you want a Star to sign in to.'}{!on && list.data?.logins.length ? ' Stars can’t use them while this is off.' : ''}</p>
            <button className="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Save a login</button>
          </div>
        </div>
      </div>

      {confirming && <TurnOn onClose={() => setConfirming(false)} onDone={(s) => { setSettings(s); setConfirming(false); toast('Password fill on'); }} />}
      {adding && <LoginForm onClose={() => setAdding(false)} onSaved={(l) => { list.setData((d) => d && { ...d, logins: [...d.logins, l] }); setAdding(false); toast(`Saved the login for ${hostOf(l.origin)}`); }} />}
    </section>
  );
}

/** The explanation and the confirmation step before turning it on. */
function TurnOn({ onClose, onDone }: { onClose: () => void; onDone: (s: Awaited<ReturnType<typeof api.updateSettings>>) => void }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try { onDone(await api.updateSettings({ passwordFill: true })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg fill-confirm" role="alertdialog" aria-modal="true" aria-labelledby="pf-title" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (sure) go(); }}>
        <div className="between">
          <h2 id="pf-title">Let Stars sign in for you?</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="fill-relax">
          <span className="label" style={{ margin: 0 }}>What this relaxes</span>
          <p>One built-in rule, <em>“Never change passwords or security settings”</em>, in exactly one way: a Star may sign in to a site with a login you saved here. A signed-in Star can then do what that account can, still within your rules and approvals.</p>
        </div>
        <div>
          <span className="label">What stays the same</span>
          <ul className="fill-keeps">
            <li><Icon name="check" size={14} />The password goes straight into the page. The Star, its model, the timeline and the logs never see it.</li>
            <li><Icon name="check" size={14} />It only fills on the exact site you saved it for, so a look-alike site gets nothing.</li>
            <li><Icon name="check" size={14} />Only over https.</li>
            <li><Icon name="check" size={14} />Never on sign-up or change-password forms.</li>
            <li><Icon name="check" size={14} />Each fill asks you first, unless you turn on “Fill without asking” for that login.</li>
            <li><Icon name="check" size={14} />Stars still can’t type into password fields themselves.</li>
            <li><Icon name="check" size={14} />You choose which Stars can use each login.</li>
          </ul>
        </div>
        <label className="fill-sure">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>I understand a Star will be able to sign in to the sites I save.</span>
        </label>
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet" onClick={onClose} autoFocus>Keep it off</button>
          <button type="submit" className="btn ink" disabled={!sure || busy}>{busy ? 'Turning on…' : 'Turn on'}</button>
        </div>
      </form>
    </div>
  );
}

function LoginRow({ login, on, who, onChange, onDelete }: { login: SavedLogin; on: boolean; who: string; onChange: (l: SavedLogin) => void; onDelete: () => void }) {
  const toast = useToast();
  const [replacing, setReplacing] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);

  const patch = async (p: Parameters<typeof api.updateLogin>[1], done?: string) => {
    try { onChange(await api.updateLogin(login.id, p)); if (done) toast(done); } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="r col login-row" style={{ alignItems: 'stretch', gap: 10 }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="app-logo" style={{ background: 'var(--raised)', color: 'var(--text)' }}>{hostOf(login.origin)[0]?.toUpperCase()}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 style={{ overflowWrap: 'anywhere' }}>{hostOf(login.origin)}</h3>
          <p className="t3 xs" style={{ overflowWrap: 'anywhere' }}>{login.username} · <span className="mono">••••••••</span> · {who}{login.lastUsedAt ? ` · used ${relTime(login.lastUsedAt)}` : ''}</p>
        </div>
        {confirm ? (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm danger" onClick={async () => { try { await api.deleteLogin(login.id); onDelete(); toast('Login deleted'); } catch (e) { toast((e as Error).message); } }}>Delete</button>
            <button className="btn sm quiet" onClick={() => setConfirm(false)}>Keep</button>
          </div>
        ) : (
          <div className="row" style={{ gap: 2 }}>
            <button className="btn sm quiet" onClick={() => setReplacing((v) => !v)}>Replace password</button>
            <button className="icon-btn" onClick={() => setConfirm(true)} aria-label={`Delete the login for ${hostOf(login.origin)}`}><Icon name="trash" size={16} /></button>
          </div>
        )}
      </div>
      {replacing && (
        <form className="row" style={{ gap: 8 }} onSubmit={async (e) => { e.preventDefault(); if (!password) return; await patch({ password }, 'Password replaced'); setPassword(''); setReplacing(false); }} autoComplete="off">
          <input className="field grow" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" aria-label={`New password for ${hostOf(login.origin)}`} autoFocus />
          <button className="btn sm ink" disabled={!password}>Save</button>
        </form>
      )}
      <div className="between login-auto">
        <div>
          <span style={{ fontSize: 14 }}>Fill without asking</span>
          <p className="t3 xs">{login.autoFill ? 'Fills on this site without checking with you first.' : 'Asks you before each sign-in.'}{!on && ' Only once password fill is on.'}</p>
        </div>
        <Switch label={`Fill ${hostOf(login.origin)} without asking`} checked={login.autoFill} onChange={(autoFill) => patch({ autoFill }, autoFill ? 'Fills without asking now' : 'Asks first now')} />
      </div>
    </div>
  );
}

function LoginForm({ onClose, onSaved }: { onClose: () => void; onSaved: (l: SavedLogin) => void }) {
  const { stars } = useAgent();
  const [origin, setOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [starIds, setStarIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const site = (() => { const o = origin.trim(); if (!o) return ''; try { return new URL(o.includes('://') ? o : `https://${o}`).origin; } catch { return ''; } })();
  const insecure = site.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(site);
  const toggle = (id: string) => setStarIds((cur) => { const list = cur ?? []; const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; return next.length ? next : null; });

  const save = async () => {
    setBusy(true);
    setError(null);
    try { onSaved(await api.createLogin({ origin: site, username: username.trim(), password, starIds, autoFill: false })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg" role="dialog" aria-modal="true" aria-label="Save a login" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (site && !insecure && username.trim() && password) save(); }} autoComplete="off">
        <div className="between">
          <h2>Save a login</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div>
          <label className="label" htmlFor="lg-site">Site</label>
          <input id="lg-site" className="field mono" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://github.com" spellCheck={false} autoFocus />
          <p className="t3 xs" style={{ marginTop: 6 }}>{insecure ? <span style={{ color: 'var(--warn)' }}>Only https sites, so the password can’t be read on the way.</span> : site ? <>Fills only on <span className="mono">{site}</span>, nowhere else.</> : 'It fills only on this exact site.'}</p>
        </div>
        <div className="grid2">
          <div>
            <label className="label" htmlFor="lg-user">Username or email</label>
            <input id="lg-user" className="field" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label className="label" htmlFor="lg-pass">Password</label>
            <input id="lg-pass" className="field" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        {stars && stars.length > 1 && (
          <div>
            <span className="label">Who can use it</span>
            <div className="who-filter" role="group" aria-label="Who can use it">
              <button type="button" aria-pressed={starIds === null} onClick={() => setStarIds(null)}>Every Star</button>
              {stars.map((s) => <button type="button" key={s.id} aria-pressed={!!starIds?.includes(s.id)} onClick={() => toggle(s.id)}><StarFace star={s} size={20} still />{s.name}</button>)}
            </div>
          </div>
        )}
        <p className="t3 xs"><Icon name="lock" size={12} /> Encrypted on your Sky server. You won’t see the password here again, and no Star’s model ever does.</p>
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!site || insecure || !username.trim() || !password || busy}>{busy ? 'Saving…' : 'Save login'}</button>
        </div>
      </form>
    </div>
  );
}
