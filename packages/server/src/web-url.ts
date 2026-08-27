/**
 * Builds a link into the web app for something in a guild's tournament —
 * `/t/:id`, `/t/:id/pack`, etc. Falls back to a bare relative path when
 * `PUBLIC_BASE_URL` isn't set (local dev without the env fully configured)
 * rather than throwing, same as `/pack`'s own link already did before this
 * was extracted.
 */
export function webUrl(path: string): string {
  const base = process.env['PUBLIC_BASE_URL'];
  return base ? `${base}${path}` : path;
}

/** `/t/:id` — the tournament's permanent bracket/standings page. */
export function tournamentUrl(tournamentId: string): string {
  return webUrl(`/t/${tournamentId}`);
}
