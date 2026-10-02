import { Shell } from './components/Shell';
import { useRoute } from './lib/router';
import { Activity } from './pages/Activity';
import { Approvals } from './pages/Approvals';
import { Chat } from './pages/Chat';
import { Connections } from './pages/Connections';
import { Home } from './pages/Home';
import { Memory } from './pages/Memory';
import { Rules } from './pages/Rules';
import { Settings } from './pages/Settings';
import { TaskDetailPage } from './pages/TaskDetail';
import { Tasks } from './pages/Tasks';

export function App() {
  const [section = 'home', id] = useRoute();
  let page;
  switch (section) {
    case 'chat': page = <Chat conversationId={id} />; break;
    case 'tasks': page = id ? <TaskDetailPage id={id} /> : <Tasks />; break;
    case 'approvals': page = <Approvals />; break;
    case 'memory': page = <Memory />; break;
    case 'connections': page = <Connections />; break;
    case 'rules': page = <Rules />; break;
    case 'activity': page = <Activity />; break;
    case 'settings': page = <Settings />; break;
    default: page = <Home />;
  }
  return <Shell section={section}>{page}</Shell>;
}
