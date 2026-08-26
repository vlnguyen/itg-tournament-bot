import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';

/**
 * Split by route so the console's heavier dependencies (tables, drag-and-
 * drop for seeding) never load on the public/mobile surface — see
 * DESIGN.md, "The Web Client".
 */
export const router = createBrowserRouter([
  { path: '/', lazy: () => import('./routes/public-home').then((m) => ({ Component: m.default })) },
  { path: '/console', lazy: () => import('./routes/console-home').then((m) => ({ Component: m.default })) },
]);
