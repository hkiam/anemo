import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './styles.css';
import './pages.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary area="Anwendung"><App /></ErrorBoundary></StrictMode>);
