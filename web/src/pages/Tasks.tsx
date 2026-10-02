import { useState } from 'react';
import { api, type TaskKind, type TaskStatus } from '../api';
import { Icon } from '../components/Icon';
import { TaskCard } from '../components/TaskCard';
import { Empty, ErrorNote, Segmented, Skeleton, useToast } from '../components/ui';
import { useResource } from '../lib/hooks';
import { navigate } from '../lib/router';

type Filter = 'now' | 'scheduled' | 'done' | 'all';
const FILTERS: Record<Filter, TaskStatus[] | undefined> = {
  now: ['active', 'waiting_approval', 'blocked'],
  scheduled: ['scheduled', 'paused'],
  done: ['done', 'failed'],
  all: undefined,
};

export function Tasks() {
  const [filter, setFilter] = useState<Filter>('now');
  const [creating, setCreating] = useState(false);
  const tasks = useResource(() => api.listTasks({ status: FILTERS[filter] }), [filter], ['task.updated']);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p className="sub">Everything Skys is responsible for, including what runs on a schedule.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New task</button>
      </div>

      <Segmented
        label="Filter tasks"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'now', label: 'In progress' },
          { value: 'scheduled', label: 'Scheduled' },
          { value: 'done', label: 'Finished' },
          { value: 'all', label: 'All' },
        ]}
      />

      {tasks.error ? (
        <ErrorNote error={tasks.error} retry={tasks.reload} />
      ) : !tasks.data ? (
        <Skeleton h={120} n={4} />
      ) : tasks.data.length === 0 ? (
        <Empty icon="tasks" title="Nothing here">Hand Skys something to do and it will show up here.</Empty>
      ) : (
        <div className="grid-2">{tasks.data.map((t) => <TaskCard key={t.id} task={t} />)}</div>
      )}

      {creating && <NewTaskModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewTaskModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('one_off');
  const [schedule, setSchedule] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const t = await api.createTask({ title, description, kind, schedule: kind === 'one_off' ? undefined : schedule || undefined });
    toast('Task created');
    onClose();
    navigate('tasks', t.id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="card modal stack-lg"
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="row-between">
          <h2>New task</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div>
          <label className="lbl" htmlFor="nt-title">What should Skys do?</label>
          <input id="nt-title" className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Find a birthday gift for Sam" />
        </div>
        <div>
          <label className="lbl" htmlFor="nt-desc">Details</label>
          <textarea id="nt-desc" className="field" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Budget around $80. Sam likes coffee and hiking." />
        </div>
        <div>
          <span className="lbl">How often</span>
          <Segmented
            label="Task kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'one_off', label: 'Once' },
              { value: 'recurring', label: 'On a schedule' },
              { value: 'watch', label: 'Keep watching' },
            ]}
          />
        </div>
        {kind !== 'one_off' && (
          <div>
            <label className="lbl" htmlFor="nt-sched">{kind === 'watch' ? 'Check how often' : 'Schedule'}</label>
            <input id="nt-sched" className="field" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={kind === 'watch' ? 'Every 3 hours' : 'Weekdays at 9:00'} />
          </div>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>Start task</button>
        </div>
      </form>
    </div>
  );
}
