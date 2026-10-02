import { useState } from 'react';
import { api, type Approval } from '../api';
import { relTime } from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { ApprovalChip, useToast } from './ui';

/**
 * A structured yes/no for anything Skys can't undo. Shows exactly what will
 * happen and lets you edit it first.
 */
export function ApprovalCard({ approval, onDecided, compact = false }: { approval: Approval; onDecided?: (a: Approval) => void; compact?: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.preview);
  const [expanded, setExpanded] = useState(!compact);
  const [busy, setBusy] = useState(false);
  const pending = approval.status === 'pending';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const a = await api.decideApproval(approval.id, { decision, editedPreview: editing && draft !== approval.preview ? draft : undefined });
      toast(decision === 'approve' ? 'Approved' : 'Declined');
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
        {pending ? <><Icon name="bolt" size={13} /> Needs your OK</> : <ApprovalChip status={approval.status} />}
        <span className="grow" />
        <span className="t3 xs" style={{ fontWeight: 400 }}>{relTime(approval.createdAt)}</span>
      </div>
      <div className="ci-body">
        <div>
          <h3>{approval.action} <span className="t2" style={{ fontWeight: 400 }}>to {approval.target}</span></h3>
          {!compact && <p className="t2" style={{ fontSize: 14, marginTop: 2 }}>{approval.reason}</p>}
        </div>
        {editing ? (
          <textarea className="field" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit before approving" autoFocus />
        ) : (
          <pre className={`quote ${expanded ? '' : 'clamp'}`} onClick={() => setExpanded(true)}>{approval.preview}</pre>
        )}
        {pending ? (
          <div className="row wrap">
            <button className="btn ink sm" onClick={() => decide('approve')} disabled={busy}>
              {editing ? 'Send edited' : 'Approve'}
            </button>
            <button className="btn sm" onClick={() => setEditing((v) => !v)} disabled={busy}>{editing ? 'Cancel' : 'Edit'}</button>
            <button className="btn quiet sm" onClick={() => decide('reject')} disabled={busy}>Not now</button>
            {!compact && approval.taskId && <><span className="grow" /><a className="t3 xs" href={href('goals', approval.taskId)}>From a goal</a></>}
          </div>
        ) : null}
      </div>
    </article>
  );
}
