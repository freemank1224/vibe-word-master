
import React, { useLayoutEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './contexts/LanguageContext';
import { prepareIconFont, revealApplication } from './services/startup';
import './styles/global.css';

function StartupReady() {
  useLayoutEffect(() => { revealApplication(document); }, []);
  return null;
}

prepareIconFont(document);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
      <StartupReady />
    </LanguageProvider>
  </React.StrictMode>
);
