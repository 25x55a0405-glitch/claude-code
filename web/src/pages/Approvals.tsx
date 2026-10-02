import { useState } from 'react';
import { api, type ApprovalStatus } from '../api';
import { ApprovalCard } from '../components/ApprovalCard';
import { Empty, ErrorNote, Segmented, Skeleton } from '../components/ui';
import { useResource } from '../lib/hooks';

export function Approvals() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const list = useResource(
    async () => {
      const all = await api.listApprovals(tab === 'pending' ? 'pending' : undefined);
      return tab === 'pending' ? all : all.filter((a) => a.status !== ('pending' as ApprovalStatus));
    },
    [tab],
    ['approval.created', 'approval.updated'],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="sub">Skys checks with you before anything that sends, spends, or can’t be undone.</p>
        </div>
        <Segmented label="Show" value={tab} onChange={setTab} options={[{ value: 'pending', label: 'Waiting' }, { value: 'history', label: 'History' }]} />
      </div>
      {list.error ? (
        <ErrorNote error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <Skeleton h={220} n={2} />
      ) : list.data.length === 0 ? (
        <Empty icon="approve" title={tab === 'pending' ? 'You’re all caught up' : 'No decisions yet'}>
          {tab === 'pending' ? 'When Skys needs your OK, it will show up here and on your phone.' : 'Approved and declined actions appear here.'}
        </Empty>
      ) : (
        <div className="stack-lg">{list.data.map((a) => <ApprovalCard key={a.id + a.status} approval={a} onDecided={list.reload} />)}</div>
      )}
    </div>
  );
}
