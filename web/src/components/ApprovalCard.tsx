import { useState } from 'react';
import { api, type Approval } from '../api';
import { relTime } from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { ApprovalStatusPill, RiskPill, useToast } from './ui';

export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided?: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.preview);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const pending = approval.status === 'pending';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      await api.decideApproval(approval.id, {
        decision,
        editedPreview: editing && draft !== approval.preview ? draft : undefined,
        note: note.trim() || undefined,
      });
      toast(decision === 'approve' ? 'Approved. Skys is on it.' : 'Declined. Skys won’t do this.');
      onDecided?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="card approval" data-risk={approval.risk}>
      <div className="row-between">
        <div className="row">
          <div className="icon-tile" style={{ color: 'var(--dawn)' }}><Icon name="bolt" size={16} /></div>
          <div>
            <h3>{approval.action} · <span className="muted">{approval.target}</span></h3>
            <p className="faint">
              Asked {relTime(approval.createdAt)}
              {approval.taskId && <> · <a href={href('tasks', approval.taskId)} style={{ color: 'var(--sky)' }}>View task</a></>}
            </p>
          </div>
        </div>
        <div className="row">
          <RiskPill risk={approval.risk} />
          {!pending && <ApprovalStatusPill status={approval.status} />}
        </div>
      </div>

      <p>{approval.reason}</p>

      {editing ? (
        <textarea className="field" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Edit before approving" />
      ) : (
        <pre className="preview">{approval.preview}</pre>
      )}

      {pending && (
        <>
          <input className="field" placeholder="Optional note for Skys (it will remember this)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row">
            <button className="btn btn-primary" onClick={() => decide('approve')} disabled={!!busy}>
              <Icon name="check" size={16} /> {busy === 'approve' ? 'Approving…' : editing ? 'Approve edited' : 'Approve'}
            </button>
            <button className="btn" onClick={() => setEditing((v) => !v)} disabled={!!busy}>
              <Icon name="edit" size={16} /> {editing ? 'Cancel edit' : 'Edit'}
            </button>
            <span className="spacer" />
            <button className="btn btn-ghost btn-danger" onClick={() => decide('reject')} disabled={!!busy}>
              <Icon name="x" size={16} /> Decline
            </button>
          </div>
          {approval.expiresAt && <p className="faint">If you don’t answer, Skys will skip this {relTime(approval.expiresAt)}.</p>}
        </>
      )}
    </article>
  );
}
