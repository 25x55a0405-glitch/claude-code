import { useEffect, useState } from 'react';
import { api, type Secret } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { useResource } from '../lib/hooks';
import { Icon } from './Icon';
import { ErrorNote, Skeleton, StarFace, useToast } from './ui';

const NAME_OK = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Values Stars can use without ever seeing them. The UI only sends a value; it
 * never gets one back, so there is nothing to reveal or copy.
 */
export function SecretsVault() {
  const { stars } = useAgent();
  const list = useResource(() => api.listSecrets(), []);
  const [open, setOpen] = useState<Secret | 'new' | null>(null);
  const many = (stars?.length ?? 0) > 1;
  const names = (ids: string[] | null) => (ids === null ? 'Every Star' : ids.map((id) => stars?.find((s) => s.id === id)?.name ?? 'a removed Star').join(', ') || 'No Star yet');

  return (
    <section>
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Secrets</div>
        <button className="btn sm" onClick={() => setOpen('new')}><Icon name="plus" size={14} /> Add a secret</button>
      </div>
      {list.data?.keySource === 'memory' && (
        <p className="send-error" style={{ margin: '0 0 10px' }}>The server has no lasting encryption key, so these secrets are lost when it restarts. Set SKY_SECRET_KEY on the server to keep them.</p>
      )}
      <div className="panel">
        <div className="rows">
          {list.error ? <div className="r"><ErrorNote error={list.error} retry={list.reload} /></div> : !list.data ? <div className="r"><Skeleton h={30} n={2} /></div> : list.data.secrets.length === 0 ? (
            <div className="r t3">Store a key, code or password once. Stars write its name and Sky fills in the value just before the action runs, after asking you.</div>
          ) : list.data.secrets.map((s) => (
            <button key={s.id} className="r secret-row" onClick={() => setOpen(s)}>
              <span className="glyph"><Icon name="lock" size={16} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <h3 className="mono" style={{ fontSize: 13.5 }}>{s.name}</h3>
                <p className="t3 xs">{[s.description, many ? names(s.starIds) : null, s.lastUsedAt ? `used ${relTime(s.lastUsedAt)}` : 'not used yet'].filter(Boolean).join(' · ')}</p>
              </div>
              <span className="dots" aria-hidden="true">••••••</span>
            </button>
          ))}
        </div>
      </div>
      <p className="t3 xs" style={{ marginTop: 8 }}>
        Encrypted on your Sky server{list.data?.keySource === 'file' ? ' with a key file in its data folder. Back that file up, or the secrets can’t be read' : ''}. Using one always asks you first, and values are never shown again, not even here.
      </p>
      {open && <SecretForm secret={open === 'new' ? null : open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); list.reload(); }} />}
    </section>
  );
}

function SecretForm({ secret, onClose, onDone }: { secret: Secret | null; onClose: () => void; onDone: () => void }) {
  const { stars } = useAgent();
  const toast = useToast();
  const [name, setName] = useState(secret?.name ?? '');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(secret?.description ?? '');
  const [starIds, setStarIds] = useState<string[] | null>(secret ? secret.starIds : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => {
    const cur = starIds ?? [];
    setStarIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (secret) {
        await api.updateSecret(secret.name, { description: description.trim(), starIds, ...(value ? { value } : {}) });
      } else {
        await api.createSecret({ name: name.trim(), value, description: description.trim(), starIds });
      }
      setValue('');
      toast(secret ? 'Saved' : `${name.trim()} stored`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try { await api.deleteSecret(secret!.name); toast(`${secret!.name} deleted`); onDone(); } catch (e) { setError((e as Error).message); }
  };

  const nameBad = !secret && name.trim() !== '' && !NAME_OK.test(name.trim());
  const valid = (secret || (NAME_OK.test(name.trim()) && value)) && !(starIds && starIds.length === 0);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg provider-form" role="dialog" aria-modal="true" aria-label={secret ? secret.name : 'Add a secret'} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (valid) save(); }} autoComplete="off">
        <div className="between">
          <h2>{secret ? <span className="mono" style={{ fontSize: 'inherit' }}>{secret.name}</span> : 'Add a secret'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {!secret && (
          <div>
            <label className="label" htmlFor="sec-name">Name</label>
            <input id="sec-name" className="field mono" value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, '_'))} placeholder="AIRLINE_LOYALTY" spellCheck={false} autoFocus />
            <p className={`xs ${nameBad ? '' : 't3'}`} style={{ marginTop: 6, color: nameBad ? 'var(--danger)' : undefined }}>Letters, digits and _, starting with a letter. Stars refer to it as {'{{secret:'}{name.trim() || 'NAME'}{'}}'}.</p>
          </div>
        )}
        <div>
          <label className="label" htmlFor="sec-value">{secret ? 'New value' : 'Value'}</label>
          {secret && !value && <div className="key-saved" style={{ marginBottom: 8 }}><Icon name="lock" size={15} /><span className="grow">A value is stored. Type below to replace it.</span></div>}
          <input id="sec-value" className="field mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={secret ? 'Leave empty to keep the current value' : 'Paste the value'} autoComplete="new-password" spellCheck={false} />
        </div>
        <div>
          <label className="label" htmlFor="sec-desc">What it’s for <span className="t3">(optional)</span></label>
          <input id="sec-desc" className="field" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="TAP Miles&Go number" />
        </div>
        {stars && stars.length > 1 && (
          <div>
            <span className="label">Who can use it</span>
            <div className="who-filter" role="group" aria-label="Who can use it">
              <button type="button" aria-pressed={starIds === null} onClick={() => setStarIds(null)}>Every Star</button>
              {stars.map((s) => (
                <button type="button" key={s.id} aria-pressed={!!starIds?.includes(s.id)} onClick={() => toggle(s.id)}><StarFace star={s} size={20} still />{s.name}</button>
              ))}
            </div>
            {starIds && starIds.length === 0 && <p className="t3 xs" style={{ marginTop: 6 }}>Pick at least one Star, or Every Star.</p>}
          </div>
        )}
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {secret && (confirm ? (
            <><button type="button" className="btn danger" onClick={remove}>Delete for good</button><button type="button" className="btn quiet" onClick={() => setConfirm(false)}>Keep</button><span className="grow" /></>
          ) : (
            <><button type="button" className="btn quiet danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Delete</button><span className="grow" /></>
          ))}
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={!valid || busy}>{busy ? 'Saving…' : secret ? 'Save' : 'Store it'}</button>
        </div>
      </form>
    </div>
  );
}
