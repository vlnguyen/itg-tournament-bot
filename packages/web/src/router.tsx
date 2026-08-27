import { createBrowserRouter } from 'react-router-dom';
import Layout from './components/layout.js';

/**
 * Split by route so the console's heavier dependencies (tables, drag-and-
 * drop for seeding) never load on the public/mobile surface — see
 * DESIGN.md, "The Web Client". URL scheme per DESIGN.md, "Permanent
 * URLs"/"Player pages": `/t/:tournamentId` never changes or gets reused;
 * `/g/:guildId` is the server's own page — active tournament, history, or
 * first-run setup — not a redirect into one.
 *
 * Every page nests under `Layout`, the one piece of chrome shared across
 * the whole app (currently just the color-scheme toggle) — not lazy, since
 * it's on every route regardless.
 */
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', lazy: () => import('./routes/public-home').then((m) => ({ Component: m.default })) },
      { path: '/g/:guildId', lazy: () => import('./routes/guild-overview').then((m) => ({ Component: m.default })) },
      { path: '/g/:guildId/setup', lazy: () => import('./routes/guild-setup').then((m) => ({ Component: m.default })) },
      { path: '/g/:guildId/dashboard', lazy: () => import('./routes/guild-dashboard').then((m) => ({ Component: m.default })) },
      { path: '/t/:tournamentId', lazy: () => import('./routes/tournament-bracket').then((m) => ({ Component: m.default })) },
      {
        path: '/t/:tournamentId/matches/:matchId',
        lazy: () => import('./routes/match-detail').then((m) => ({ Component: m.default })),
      },
      { path: '/t/:tournamentId/pack', lazy: () => import('./routes/tournament-pack').then((m) => ({ Component: m.default })) },
      {
        path: '/t/:tournamentId/console',
        lazy: () => import('./routes/tournament-console').then((m) => ({ Component: m.default })),
      },
      {
        path: '/t/:tournamentId/roster',
        lazy: () => import('./routes/tournament-roster').then((m) => ({ Component: m.default })),
      },
      {
        path: '/t/:tournamentId/config',
        lazy: () => import('./routes/tournament-lifecycle').then((m) => ({ Component: m.default })),
      },
      {
        path: '/g/:guildId/players/:discordUserId',
        lazy: () => import('./routes/player-page').then((m) => ({ Component: m.default })),
      },
      { path: '/console', lazy: () => import('./routes/console-home').then((m) => ({ Component: m.default })) },
    ],
  },
]);
