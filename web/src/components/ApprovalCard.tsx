import { useState } from 'react';
import { BrowserWindow, useBrowserTab } from './BrowserView';
import { api, type Approval } from '../api';
import { useAgent } from '../lib/agent';
import { relTime } from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { ApprovalChip, StarFace, useToast } from './ui';

/**
 * A structured yes/no for anything Sky can't undo. Shows exactly what will
 * happen and lets you edit it first.
 */
export function ApprovalCard({ approval, onDecided, compact = false }: { approval: Approval; onDecided?: (a: Approval) => void; compact?: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.preview);
  const [expanded, setExpanded] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const pending = approval.status === 'pending';
  const { stars } = useAgent();
  const asker = stars && stars.length > 1 ? stars.find((s) => s.id === approval.starId) : undefined;
  const who = stars?.find((s) => s.id === approval.starId);
  const [paying, setPaying] = useState(false);
  // Two kinds that read better said plainly: paying at a checkout, and touching your own computer.
  const pay = /^Pay (\S+) at (.+)$/.exec(approval.action);
  const computer = approval.connectionId === 'computer';
  const verb = approval.action.charAt(0).toLowerCase() + approval.action.slice(1);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const a = await api.decideApproval(approval.id, { decision, editedPreview: editing && draft !== approval.preview ? draft : undefined });
      toast(decision === 'approve' ? (pay ? 'Your turn: pay, then press Hand back' : 'Approved') : 'Declined');
      if (pay && decision === 'approve' && who) setPaying(true);
      onDecided?.(a);
    } catch (e) {
      // e.g. 409 when it was already answered on another device.
      toast((e as Error).message);
      onDecided?.(approval);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`card-inline ${pending ? 'attn' : 'settled'}`} style={compact ? undefined : { width: '100%' }}>
      <div className="ci-head">
        {asker && !compact && <><StarFace star={asker} size={16} still /> {asker.name} ·</>}
        {pending ? <><Icon name="bolt" size={13} /> Needs your OK</> : <ApprovalChip status={approval.status} />}
        <span className="grow" />
        <span className="t3 xs" style={{ fontWeight: 400 }}>{relTime(approval.createdAt)}</span>
      </div>
      <div className="ci-body">
        {pay ? (
          <div className="pay-head">
            <span className="glyph"><Icon name="card" size={17} /></span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="pay-total">{pay[1]}</div>
              <p className="t2" style={{ fontSize: 14 }}>at {pay[2]}</p>
            </div>
          </div>
        ) : computer ? (
          <div>
            <h3>{who?.name ?? 'Sky'} wants to {verb}</h3>
            <p className="t2 row" style={{ fontSize: 14, marginTop: 2, gap: 6 }}><Icon name="laptop" size={14} /> On {approval.target}{!compact && approval.reason ? `. ${approval.reason}` : ''}</p>
          </div>
        ) : (
          <div>
            <h3>{approval.action} <span className="t2" style={{ fontWeight: 400 }}>to {approval.target}</span></h3>
            {!compact && <p className="t2" style={{ fontSize: 14, marginTop: 2 }}>{approval.reason}</p>}
          </div>
        )}
        {editing ? (
          <textarea className="field" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit before approving" autoFocus />
        ) : (
          <pre className={`quote ${expanded ? '' : 'clamp'}`} onClick={() => setExpanded(true)}>{approval.preview}</pre>
        )}
        {pay && pending && <p className="pay-note"><Icon name="lock" size={13} /> Saying yes gives you the browser on the payment page. You pay, then press Hand back. {who?.name ?? 'Sky'} never enters card details.</p>}
        {computer && pending && <p className="t3 xs">Allowed only inside what you set on that computer. It may ask there too.</p>}
        {pending ? (
          <div className="row wrap">
            <button className="btn ink sm" onClick={() => decide('approve')} disabled={busy}>
              {editing ? 'Send edited' : pay ? 'OK, I’ll pay' : computer ? 'Allow' : 'Approve'}
            </button>
            {!pay && (!computer || /^(Write|Add to) /.test(approval.action)) && <button className="btn sm" onClick={() => setEditing((v) => !v)} disabled={busy}>{editing ? 'Cancel' : 'Edit'}</button>}
            <button className="btn quiet sm" onClick={() => decide('reject')} disabled={busy}>Not now</button>
            {!compact && approval.taskId && <><span className="grow" /><a className="t3 xs" href={href('goals', approval.taskId)}>From a goal</a></>}
          </div>
        ) : null}
      </div>
      {paying && who && <PayBrowser star={who} onClose={() => setPaying(false)} />}
    </article>
  );
}

/** After an OK to pay: the Star's tab, yours until you hand it back. */
function PayBrowser({ star, onClose }: { star: NonNullable<ReturnType<typeof useAgent>['stars']>[number]; onClose: () => void }) {
  const b = useBrowserTab(star.id);
  return b.tab ? <BrowserWindow star={star} tab={b.tab} onTab={b.setTab} onClose={onClose} /> : null;
}
