import { Shell } from './components/Shell';
import { useRoute } from './lib/router';
import { Activity } from './pages/Activity';
import { Approvals } from './pages/Approvals';
import { Chat } from './pages/Chat';
import { Constellation } from './pages/Constellation';
import { Goals } from './pages/Goals';
import { Ideas } from './pages/Ideas';
import { Memory } from './pages/Memory';
import { Models } from './pages/Models';
import { Permissions } from './pages/Permissions';
import { Settings } from './pages/Settings';
import { StarEditor } from './pages/StarEditor';
import { TaskDetailPage } from './pages/TaskDetail';

export function App() {
  const [section = 'chat', id] = useRoute();
  let page;
  let scrolls = true;
  switch (section) {
    case 'goals': page = id ? <TaskDetailPage id={id} /> : <Goals />; break;
    case 'ideas': page = <Ideas />; break;
    case 'approvals': page = <Approvals />; break;
    case 'memory': page = <Memory />; break;
    case 'models': page = <Models />; break;
    case 'permissions': page = <Permissions />; break;
    case 'activity': page = <Activity />; break;
    case 'settings': page = <Settings />; break;
    case 'stars': page = id ? <StarEditor key={id} id={id} /> : <Constellation />; break;
    default: page = <Chat key={id ?? 'main'} conversationId={id} />; scrolls = false;
  }
  const current = ['goals', 'ideas', 'approvals', 'memory', 'permissions', 'activity', 'settings', 'stars', 'models'].includes(section) ? section : 'chat';
  return (
    <Shell section={current} chatId={current === 'chat' ? id : undefined} starId={current === 'stars' ? id : undefined}>
      {scrolls ? <div className="scroll" key={section + (id ?? '')}>{page}</div> : page}
    </Shell>
  );
}
