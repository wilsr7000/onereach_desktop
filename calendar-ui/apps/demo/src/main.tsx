import React from 'react';
import { createRoot } from 'react-dom/client';
import '@calendar/react/theme.css';
import './styles.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
