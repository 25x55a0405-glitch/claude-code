import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { StatusProvider } from './lib/status';
import './styles/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatusProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StatusProvider>
  </StrictMode>,
);
