import { Bo3ProtectVetoFormat, Bo3ProtectVetoFormatV2 } from '../bo3.js';
import { Bo5ProtectVetoFormat, Bo5ProtectVetoFormatV2 } from '../bo5.js';
import { Hb11StaticPoolFormat, Hb13StaticPoolFormat } from '../hubert.js';
import type { MatchFormat } from '../types.js';

/**
 * `formatKey` lives on the match, not the tournament, so replay reads the
 * key a match actually ran under rather than whatever the tournament's
 * default currently is. This registry is that lookup. See DESIGN.md,
 * "Format versioning and golden replay."
 *
 * A new ruleset is added here, never by mutating what an existing key
 * (`bo5-protect-veto`, `bo3-protect-veto`) means underneath it.
 *
 * Typed with `| undefined` on the value, not just `MatchFormat`: a lookup
 * key here is an arbitrary string (a fixture's `formatKey`, eventually a
 * live match's), so a miss is a real possibility this type has to carry —
 * unlike `bo5.ts`'s `points` record, which is only ever indexed by IDs
 * already known to be in the match.
 */
export const formatRegistry: Record<string, MatchFormat | undefined> = {
  [Bo5ProtectVetoFormat.key]: Bo5ProtectVetoFormat,
  [Bo3ProtectVetoFormat.key]: Bo3ProtectVetoFormat,
  [Bo5ProtectVetoFormatV2.key]: Bo5ProtectVetoFormatV2,
  [Bo3ProtectVetoFormatV2.key]: Bo3ProtectVetoFormatV2,
  [Hb11StaticPoolFormat.key]: Hb11StaticPoolFormat,
  [Hb13StaticPoolFormat.key]: Hb13StaticPoolFormat,
};
