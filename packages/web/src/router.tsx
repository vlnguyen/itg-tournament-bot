import { createBrowserRouter } from 'react-router-dom';

/**
 * Split by route so the console's heavier dependencies (tables, drag-and-
 * drop for seeding) never load on the public/mobile surface — see
 * DESIGN.md, "The Web Client". URL scheme per DESIGN.md, "Permanent
 * URLs"/"Player pages": `/t/:tournamentId` never changes or gets reused;
 * `/g/:guildId` is the server landing page that redirects into it.
 */
export const router = createBrowserRouter([
  { path: '/', lazy: () => import('./routes/public-home').then((m) => ({ Component: m.default })) },
  { path: '/g/:guildId', lazy: () => import('./routes/guild-landing').then((m) => ({ Component: m.default })) },
  { path: '/t/:tournamentId', lazy: () => import('./routes/tournament-bracket').then((m) => ({ Component: m.default })) },
  {
    path: '/t/:tournamentId/matches/:matchId',
    lazy: () => import('./routes/match-detail').then((m) => ({ Component: m.default })),
  },
  {
    path: '/g/:guildId/players/:discordUserId',
    lazy: () => import('./routes/player-page').then((m) => ({ Component: m.default })),
  },
  { path: '/console', lazy: () => import('./routes/console-home').then((m) => ({ Component: m.default })) },
]);
