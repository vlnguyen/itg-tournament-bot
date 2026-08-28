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

/** `/t/:tournamentId/matches/:matchId` — the match's permanent detail page on the public bracket. */
export function matchUrl(tournamentId: string, matchId: string): string {
  return webUrl(`/t/${tournamentId}/matches/${matchId}`);
}

/**
 * Replaces the first `**{name}**` in an already-built organizer-log line
 * with a markdown link to that tournament's page — `[**{name}**](url)`.
 * The organizer log embed's description renders markdown links (unlike an
 * embed title), so this is how a tournament name gets hyperlinked without
 * every call site rebuilding its own message string from scratch. Callers
 * pass a description already containing the exact bold-wrapped name, since
 * that pattern is what every lifecycle transition's message already uses.
 */
export function linkifyTournamentName(text: string, tournamentName: string, tournamentId: string): string {
  return text.replace(`**${tournamentName}**`, `[**${tournamentName}**](${tournamentUrl(tournamentId)})`);
}

/**
 * Whether a `webUrl`-built link is absolute. Discord's `EmbedBuilder#setURL`
 * rejects anything else outright (it validates against a real URL, not a
 * bare path) — so a caller hyperlinking an embed's title needs this to
 * decide whether `setURL` is safe to call at all, rather than throwing when
 * `PUBLIC_BASE_URL` isn't set.
 */
export function isAbsoluteWebUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}
