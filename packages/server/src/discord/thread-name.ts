import type { BracketSide } from '@itg/shared';

/**
 * "`WR2 · Alice vs Bob`" — bracket side and round, then both competitors,
 * fixed at creation and never renamed. See DESIGN.md, "Creating the
 * thread". `GRAND_FINAL` uses `GF<round>` rather than `GFR<round>` — round 1
 * is the first game, round 2 the reset, and design calls it "GF2," not
 * "GFR2."
 */
export function roundLabel(bracket: BracketSide, round: number): string {
  if (bracket === 'GRAND_FINAL') return `GF${round}`;
  return `${bracket === 'WINNERS' ? 'W' : 'L'}R${round}`;
}

const MAX_LENGTH = 100;

/**
 * Truncated to fit Discord's 100-character thread-name limit, "longest
 * first so both stay legible" — shave one character at a time off whichever
 * name is currently longer, rather than a fixed side or a flat percentage,
 * so two long names lose roughly equal ground instead of one being cut to
 * nothing while the other survives untouched. The tournament name is
 * appended last and never shortened by that trim — a server running one
 * tournament at a time still benefits from every thread naming it, e.g.
 * when a player has more than one match thread open across their DM/thread
 * list history. Only if trimming both competitor names to nothing still
 * doesn't fit (an implausibly long tournament name) does the whole string
 * get a hard cut, as a last resort.
 */
export function formatThreadName(bracket: BracketSide, round: number, nameA: string, nameB: string, tournamentName: string): string {
  const prefix = roundLabel(bracket, round);
  const suffix = ` · ${tournamentName}`;
  let a = nameA;
  let b = nameB;
  while (`${prefix} · ${a} vs ${b}${suffix}`.length > MAX_LENGTH && (a.length > 0 || b.length > 0)) {
    if (a.length >= b.length) a = a.slice(0, -1);
    else b = b.slice(0, -1);
  }
  const result = `${prefix} · ${a} vs ${b}${suffix}`;
  return result.length > MAX_LENGTH ? result.slice(0, MAX_LENGTH) : result;
}
