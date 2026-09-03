import type { BracketShape, BracketSide } from '@itg/shared';
import { sectionLabel } from '@itg/shared';

const MAX_LENGTH = 100;

/**
 * "`Winners Round 2 · Alice vs Bob`" — the full round name, in prose, same
 * as the website's bracket headings and run view (`sectionLabel`), not the
 * old abbreviated "WR2" this used to read. `shape`, when the caller has
 * it, upgrades the last few rounds on each side to "Finals"/"Semifinals"/
 * "Quarterfinals," matching `sectionLabel`'s own rule; omitted, it falls
 * back to the plain numbered form.
 *
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
export function formatThreadName(
  bracket: BracketSide,
  round: number,
  nameA: string,
  nameB: string,
  tournamentName: string,
  shape?: BracketShape,
): string {
  const prefix = sectionLabel(bracket, round, shape);
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
