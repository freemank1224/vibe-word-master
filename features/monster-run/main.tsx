import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../contexts/LanguageContext';
import MonsterSurf from '../monster-surf/MonsterSurf';
import '../monster-surf/monster-surf.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LanguageProvider><MonsterSurf /></LanguageProvider></React.StrictMode>,
);
