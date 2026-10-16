
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LangProvider } from './services/i18n';

// Локальная сборка стилей и шрифтов (раньше тянулось с CDN — медленно и ненадёжно в РФ).
import './index.css';
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/alice/400.css';
import '@fortawesome/fontawesome-free/css/all.min.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
