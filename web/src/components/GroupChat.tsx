import { useEffect, useState } from 'react';
import { api, type Conversation, type StarView } from '../api';
import { useAgent } from '../lib/agent';
import { navigate } from '../lib/router';
import { Icon } from './Icon';
import { StarFace, useToast } from './ui';

/** Above the composer in a group chat: tap a Star to @mention it. */
export function MentionBar({ members, onMention, onEdit }: { members: StarView[]; onMention: (name: string) => void; onEdit: () => void }) {
  return (
    <div className="mention-bar">
      <span className="t3 xs">Ask</span>
      {members.map((s) => (
        <button key={s.id} type="button" className="mention" onMouseDown={(e) => e.preventDefault()} onClick={() => onMention(s.name)} aria-label={`Mention ${s.name}`}>
          <StarFace star={s} size={18} still />@{s.name}
        </button>
      ))}
      <span className="grow" />
      <button type="button" className="btn sm quiet" onClick={onEdit}>Who’s here</button>
    </div>
  );
}

/** Pick Stars (two or more) and an optional name, for a new group chat or an existing one. */
export function GroupForm({ conv, onClose, onSaved }: { conv?: Conversation; onClose: () => void; onSaved?: (c: Conversation) => void }) {
  const { stars } = useAgent();
  const toast = useToast();
  const [ids, setIds] = useState<string[]>(conv?.starIds ?? []);
  const [title, setTitle] = useState(conv?.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (conv) {
        const c = await api.updateConversation(conv.id, { starIds: ids, title: title.trim() || undefined });
        toast('Saved');
        onSaved?.(c);
        onClose();
      } else {
        const c = await api.createGroupChat(ids, title.trim() || undefined);
        onClose();
        navigate('chat', c.id);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <form className="modal col-lg" role="dialog" aria-modal="true" aria-label={conv ? 'Who’s in this group' : 'New group chat'} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (ids.length >= 2) save(); }}>
        <div className="between">
          <h2>{conv ? 'Who’s in this group' : 'New group chat'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="group-pick">
          {stars?.map((s) => {
            const on = ids.includes(s.id);
            return (
              <button key={s.id} type="button" className={`pick ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(s.id)}>
                <StarFace star={s} size={40} still={!on} />
                <span className="nm">{s.name}</span>
                <span className="t3 xs">{s.role}</span>
                <span className="tick">{on && <Icon name="check" size={13} />}</span>
              </button>
            );
          })}
        </div>
        <div>
          <label className="label" htmlFor="gc-title">Name <span className="t3">(optional)</span></label>
          <input id="gc-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lisbon planning" />
        </div>
        <p className="t3 xs">Start a message with @Name to pick who answers. Otherwise Sky picks the best Star. A Star can bring another in, and at most two reply to each message.</p>
        {error && <p className="send-error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn ink" disabled={ids.length < 2 || busy}>{busy ? 'Saving…' : conv ? 'Save' : ids.length < 2 ? 'Pick two or more' : `Start with ${ids.length}`}</button>
        </div>
      </form>
    </div>
  );
}
