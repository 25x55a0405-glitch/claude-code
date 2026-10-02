import { useState } from 'react';
import { api } from '../api';
import { ApprovalCard } from '../components/ApprovalCard';
import { Empty, ErrorNote, PageHead, Segmented, Skeleton } from '../components/ui';
import { useResource } from '../lib/hooks';

export function Approvals() {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const list = useResource(
    async () => {
      const all = await api.listApprovals(tab === 'pending' ? 'pending' : undefined);
      return tab === 'pending' ? all : all.filter((a) => a.status !== 'pending');
    },
    [tab],
    ['approval.created', 'approval.updated'],
  );

  return (
    <div className="page">
      <PageHead title="Approvals" sub="Skys stops and asks before anything that sends, spends, or can’t be undone.">
        <Segmented label="Show" value={tab} onChange={setTab} options={[{ value: 'pending', label: 'Waiting' }, { value: 'history', label: 'History' }]} />
      </PageHead>
      {list.error ? (
        <ErrorNote error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <Skeleton h={200} n={2} />
      ) : list.data.length === 0 ? (
        <Empty title={tab === 'pending' ? 'You’re all caught up' : 'No decisions yet'}>
          {tab === 'pending' ? 'When Skys needs a yes from you, it shows up here and in chat.' : 'Things you approve or decline are kept here.'}
        </Empty>
      ) : (
        <div className="col">{list.data.map((a) => <ApprovalCard key={a.id + a.status} approval={a} onDecided={() => list.reload()} />)}</div>
      )}
    </div>
  );
}
