import type { Task } from '../api';
import { relTime } from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { Bar, StatusChip, kindMeta } from './ui';

export function TaskInline({ task }: { task: Task }) {
  const kind = kindMeta[task.kind];
  return (
    <a className="card-inline" href={href('goals', task.id)}>
      <div className="ci-head">
        <Icon name={kind.icon} size={13} /> {task.schedule ?? kind.label}
        <span className="grow" />
        <StatusChip status={task.status} />
      </div>
      <div className="ci-body">
        <h3>{task.title}</h3>
        {task.lastOutcome && <span className="t3">{task.lastOutcome}</span>}
        {task.progress !== undefined && task.status !== 'done' && <Bar value={task.progress} />}
        {task.nextRunAt && task.status !== 'done' && <span className="t3 xs">Next check {relTime(task.nextRunAt)}</span>}
      </div>
    </a>
  );
}
