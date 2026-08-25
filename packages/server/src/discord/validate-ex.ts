/**
 * "Validated to two decimals in 0.00–100.00 before it reaches the thread."
 * See DESIGN.md, "Scoring a song". Pure — the modal's raw text input is
 * checked here before anything touches the domain layer, so a malformed
 * value never becomes a `SCORE_SUBMITTED` event in the first place.
 */
export function parseExPercent(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < 0 || value > 100) return null;
  return value;
}
