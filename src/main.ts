// src/main.ts (WP14) — entry point. Boot failures are shown by the app's error screen (createApp handles them);
// this file only guards against a missing root element.

import { createApp } from './app/App.ts';

const root = document.getElementById('app');
if (root) {
  createApp(root).start().catch(() => { /* recorded in stats().errors and shown on the error screen */ });
} else {
  document.body.textContent = 'Backrooms: missing #app root element.';
}
