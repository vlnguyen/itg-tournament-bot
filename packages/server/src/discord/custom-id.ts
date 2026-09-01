/**
 * Stateless component `custom_id`s: `v1:<matchId>:<action>:<arg>`. See
 * DESIGN.md, "Stateless components" — no in-memory registry, no collectors;
 * everything a handler needs is in the id itself, so a button posted by a
 * previous process is still fully functional after a restart.
 *
 * `arg` is only present for a **button**, where the choice has nowhere else
 * to live. A select menu's `custom_id` names the action alone — the chosen
 * option arrives separately, in the interaction's own `values`.
 *
 * A cuid match id is 25 characters, comfortably inside Discord's
 * 100-character limit with room for an action name and a chart id as `arg`
 * — `encodeCustomId` still checks, so an oversized id fails at the point
 * it's built rather than as a mysterious Discord API rejection later.
 */

const VERSION = 'v1';
const SEPARATOR = ':';
const MAX_LENGTH = 100;

export interface CustomId {
  matchId: string;
  action: string;
  arg?: string;
}

export function encodeCustomId(id: CustomId): string {
  const parts = [VERSION, id.matchId, id.action, ...(id.arg !== undefined ? [id.arg] : [])];
  const encoded = parts.join(SEPARATOR);
  if (encoded.length > MAX_LENGTH) {
    throw new RangeError(
      `custom_id exceeds Discord's ${MAX_LENGTH}-character limit: "${encoded}" (${encoded.length})`,
    );
  }
  return encoded;
}

/** `null` on anything that isn't a well-formed `v1` id — never throws, since this reads untrusted input off the wire. */
export function decodeCustomId(raw: string): CustomId | null {
  const parts = raw.split(SEPARATOR);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [version, matchId, action, arg] = parts;
  if (version !== VERSION || !matchId || !action) return null;
  return arg !== undefined ? { matchId, action, arg } : { matchId, action };
}

/**
 * A second, tournament-scoped codec — `t1:<tournamentId>:<action>:<arg>` —
 * for the one interaction that has no match at all: the mixed-format
 * conflict `setTournamentFormat` throws when a TO changes the default
 * against a bracket that isn't all on one format (see
 * `MixedFormatConflictError`). A separate prefix rather than widening `v1:`
 * to make `matchId` optional there: `decodeCustomId` already returns `null`
 * for anything not starting with `v1:`, so this can't collide with or
 * change the meaning of an existing id.
 */
export interface TournamentCustomId {
  tournamentId: string;
  action: string;
  arg?: string;
}

const TOURNAMENT_VERSION = 't1';

export function encodeTournamentCustomId(id: TournamentCustomId): string {
  const parts = [TOURNAMENT_VERSION, id.tournamentId, id.action, ...(id.arg !== undefined ? [id.arg] : [])];
  const encoded = parts.join(SEPARATOR);
  if (encoded.length > MAX_LENGTH) {
    throw new RangeError(
      `custom_id exceeds Discord's ${MAX_LENGTH}-character limit: "${encoded}" (${encoded.length})`,
    );
  }
  return encoded;
}

/** `null` on anything that isn't a well-formed `t1` id — same contract as `decodeCustomId`. */
export function decodeTournamentCustomId(raw: string): TournamentCustomId | null {
  const parts = raw.split(SEPARATOR);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [version, tournamentId, action, arg] = parts;
  if (version !== TOURNAMENT_VERSION || !tournamentId || !action) return null;
  return arg !== undefined ? { tournamentId, action, arg } : { tournamentId, action };
}
