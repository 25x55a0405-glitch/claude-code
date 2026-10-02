import type { Task } from '../api';
import { relTime } from '../lib/format';
import { href } from '../lib/router';
import { Icon } from './Icon';
import { Progress, TaskStatusPill, kindMeta } from './ui';

export function TaskCard({ task }: { task: Task }) {
  const kind = kindMeta[task.kind];
  return (
    <a className="task-card" href={href('tasks', task.id)}>
      <div className="row-between">
        <h3>{task.title}</h3>
        <TaskStatusPill status={task.status} />
      </div>
      {task.lastOutcome && <p className="outcome">{task.lastOutcome}</p>}
      {task.progress !== undefined && task.status !== 'done' && <Progress value={task.progress} />}
      <div className="row faint">
        <Icon name={kind.icon} size={14} />
        <span>{task.schedule ?? kind.label}</span>
        <span className="spacer" />
        <span>{task.nextRunAt && task.status !== 'paused' ? `Next ${relTime(task.nextRunAt)}` : `Updated ${relTime(task.updatedAt)}`}</span>
      </div>
    </a>
  );
}
