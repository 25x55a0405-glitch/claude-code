import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { AgentProvider } from './lib/agent';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AgentProvider>
  </StrictMode>,
);
