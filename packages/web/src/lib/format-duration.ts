/** "12m", "1h 4m" — how long ago an ISO timestamp was, for the run view's "how long has this been waiting/going" columns. Floors at "0m" rather than going negative on clock skew. */
export function elapsedLabel(sinceIso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(sinceIso).getTime());
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
