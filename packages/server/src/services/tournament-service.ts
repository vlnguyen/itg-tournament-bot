import { Prisma, type Guild, type PrismaClient, type Tournament, type TournamentState } from '@prisma/client';
import { DEFAULT_TOURNAMENT_CONFIG, type LifecycleAction, type LifecycleStatus } from '@itg/shared';
import { Bo5ProtectVetoFormat } from '../domain/bo5.js';
import { matchKey, type MatchRef } from '../domain/bracket.js';
import { logAction } from './audit-log.js';
import { generateBracketGraph, materializeBracket } from './bracket-service.js';
import { requireFormat, TournamentTransitionError, type Tx } from './engine.js';
import type { RandomPort } from './ports.js';
import { songPoolIssuesSummary, staticPoolFormatKeysInPlay, validateSongPool } from './song-pool-service.js';

export { TournamentTransitionError };

/**
 * The tournament lifecycle state machine — see DESIGN.md, "Tournament
 * Lifecycle". "Every transition is an explicit TO action; nothing in the
 * lifecycle is on a timer," and the state machine is the guard. Discord is
 * never touched here: permission preflight, the tier-role-overlap warning,
 * and thread provisioning all need a live guild and belong to the command
 * layer (`discord/commands/tournament.ts`), which calls these functions and
 * layers that on top. Mirrors the split `bracket-service.ts` and
 * `match-service.ts` already draw.
 */

/** Thrown by `createTournament` when the guild already holds one — see `findActiveTournament`. */
export class TournamentSlotOccupiedError extends Error {
  constructor(
    readonly guildId: string,
    readonly held: Tournament,
  ) {
    super(`guild ${guildId} already holds "${held.name}" (${held.state})`);
    this.name = 'TournamentSlotOccupiedError';
  }
}

/** Only one ruleset ships — see DESIGN.md, "Configurability". Every tournament is stamped with it; a picker offering a real choice is a later addition. */
const DEFAULT_FORMAT_KEY = Bo5ProtectVetoFormat.key;

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * "A tournament occupies the slot from the moment it is created." See
 * `constraints.sql`'s `one_active_tournament_per_guild` comment. Checked
 * here for a friendly error inside the same transaction as the `create`;
 * that partial unique index — `WHERE state NOT IN ('COMPLETE', 'CANCELLED')`
 * — is what actually guarantees it under a race between two concurrent
 * creates.
 */
export async function createTournament(
  prisma: PrismaClient,
  guildId: string,
  name: string,
  actorId: string,
): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const held = await findActiveTournament(tx, guildId);
    if (held) {
      throw new TournamentSlotOccupiedError(guildId, held);
    }

    try {
      const tournament = await tx.tournament.create({
        data: {
          guildId,
          name,
          defaultFormatKey: DEFAULT_FORMAT_KEY,
          config: DEFAULT_TOURNAMENT_CONFIG,
          state: 'DRAFT',
        },
      });
      await logAction(tx, actorId, 'TOURNAMENT_CREATED', 'Tournament', tournament.id, { name });
      return tournament;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_CONSTRAINT_VIOLATION) {
        const held2 = await findActiveTournament(tx, guildId);
        throw new TournamentSlotOccupiedError(guildId, held2 ?? (await tx.tournament.findFirstOrThrow({ where: { guildId } })));
      }
      throw err;
    }
  });
}

/**
 * "One tournament held per guild, from the moment it is created." See
 * `constraints.sql`'s `one_active_tournament_per_guild` comment. `null` when
 * the guild has no tournament right now, or its last one finished or was
 * cancelled — `roster-service.ts` and `discord/commands/tournament.ts` both
 * resolve "the tournament this guild is holding" through this one function.
 */
export async function findActiveTournament(tx: Tx, guildId: string): Promise<Tournament | null> {
  return tx.tournament.findFirst({ where: { guildId, state: { notIn: ['COMPLETE', 'CANCELLED'] } } });
}

/**
 * The one case where a `DRAFT` tournament is meant to surface — the
 * first-run wizard pointing its own organizer back at it to continue
 * setup. Never call this from a path a non-organizer can reach; see
 * `FirstRunStatus` in `@itg/shared` for why.
 */
export async function findDraftTournament(tx: Tx, guildId: string): Promise<Tournament | null> {
  return tx.tournament.findFirst({ where: { guildId, state: 'DRAFT' } });
}

/**
 * The *public* notion of "the guild's current tournament" — distinct from
 * `findActiveTournament`: `DRAFT` is excluded, since "nothing public has
 * happened yet... naming it would announce a tournament before its
 * organizer chose to," per `discord/commands/tournament.ts`'s
 * `handleStatus`. Shared by the landing-page redirect and `/pack`, which
 * both need "is there a live one right now," not a fallback to history —
 * `/pack` in particular: "a link to a past pack comes from that
 * tournament's archived page, which is permanent anyway."
 */
export async function findPublicCurrentTournament(tx: Tx, guildId: string): Promise<Tournament | null> {
  return tx.tournament.findFirst({ where: { guildId, state: { notIn: ['DRAFT', 'COMPLETE', 'CANCELLED'] } } });
}

/**
 * Every tournament this guild has actually finished or called off, newest
 * first — the `/g/:guildId` page's history section. `DRAFT` is excluded
 * for the same reason `findPublicCurrentTournament` excludes it, and
 * `RUNNING`/etc. are excluded because those are "active," not "history."
 */
export async function getTournamentHistory(tx: Tx, guildId: string): Promise<Tournament[]> {
  return tx.tournament.findMany({
    where: { guildId, state: { in: ['COMPLETE', 'CANCELLED'] } },
    orderBy: { createdAt: 'desc' },
  });
}

async function requireState(tx: Tx, tournamentId: string, expected: TournamentState): Promise<Tournament> {
  const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  if (t.state !== expected) {
    throw new TournamentTransitionError(tournamentId, `expected state ${expected}, but it is ${t.state}`);
  }
  return t;
}

async function requireStateIn(tx: Tx, tournamentId: string, expected: readonly TournamentState[]): Promise<Tournament> {
  const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  if (!expected.includes(t.state)) {
    throw new TournamentTransitionError(tournamentId, `expected state ${expected.join(' or ')}, but it is ${t.state}`);
  }
  return t;
}

/** "Guild configured" from the `DRAFT → REGISTRATION_OPEN` guard — every channel and tier role `/setup` binds, checked as plain DB fields. Live Discord permission resolution is a different check, run at tournament start and in `/setup status`. */
export function missingGuildConfig(guild: Guild | null): string[] {
  if (!guild) {
    return ['matches channel', 'organizer alert channel', 'results channel', 'Referee role', 'Tournament Organizer role'];
  }
  const missing: string[] = [];
  if (!guild.matchesChannelId) missing.push('matches channel');
  if (!guild.alertChannelId) missing.push('organizer alert channel');
  if (!guild.resultsChannelId) missing.push('results channel');
  if (!guild.refereeRoleId) missing.push('Referee role');
  if (!guild.toRoleId) missing.push('Tournament Organizer role');
  return missing;
}

/**
 * `DRAFT → REGISTRATION_OPEN`, and also `REGISTRATION_CLOSED`/
 * `CHECKIN_OPEN`/`CHECKIN_CLOSED → REGISTRATION_OPEN` — reopening, from as
 * far back as check-in having already closed. This is deliberately wider
 * than the "one step back" reversal every other pre-`RUNNING` transition
 * sticks to: reopening registration mid- or post-check-in is a real,
 * larger correction (a TO who started check-in too early, or needs the
 * field open again after closing it), not the single-step undo those
 * exist for.
 *
 * A bare state flip, same as always — `checkedIn`/`seed` are untouched, so
 * check-ins from before the reopen are preserved exactly as they were.
 * There is no bulk "welcome back" recovery for anyone who withdrew or was
 * dropped in the meantime; re-adding them is `/roster add`'s job, same as
 * any other late addition.
 *
 * No "another tournament active" check here any more — `createTournament`
 * already guarantees this tournament is the only non-terminal one this
 * guild has, so there is nothing left to race against by the time this
 * transition runs.
 */
export async function openRegistration(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await requireStateIn(tx, tournamentId, ['DRAFT', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED']);
    requireFormat(t.defaultFormatKey); // "format chosen" — cannot fail today; see DESIGN.md's note on the same assertion at start.

    const guild = await tx.guild.findUnique({ where: { id: t.guildId } });
    const missing = missingGuildConfig(guild);
    if (missing.length > 0) {
      throw new TournamentTransitionError(tournamentId, `this server isn't fully configured yet, missing: ${missing.join(', ')}. Run /setup.`);
    }

    await discardBracketIfReopening(tx, tournamentId, t.state);

    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'REGISTRATION_OPEN' } });
    await logAction(tx, actorId, 'REGISTRATION_OPENED', 'Tournament', tournamentId, {});
    return updated;
  });
}

/**
 * A bracket generated ahead of start (`GENERATE_BRACKET`) is only ever valid
 * for the field it was built against. Reopening registration or check-in
 * from `CHECKIN_CLOSED` — the one state a bracket can exist in pre-`RUNNING`
 * — lets that field change again, so any pre-generated rows are discarded.
 * Always safe: every `Match` row that can exist this early is `PENDING` by
 * construction (nothing seats or starts before `RUNNING`).
 *
 * `bracketEntrantCount`/`formatOverrides` are deliberately **not** cleared —
 * `generateBracketGraph`'s resize rule reads them at the next generation to
 * decide whether the TO's per-match assignments still apply.
 */
async function discardBracketIfReopening(tx: Tx, tournamentId: string, fromState: TournamentState): Promise<void> {
  if (fromState === 'CHECKIN_CLOSED') {
    await tx.match.deleteMany({ where: { tournamentId } });
  }
}

/**
 * "A `/tournament rename` option should be available if a tournament is
 * being held." Available in any state short of `COMPLETE`/`CANCELLED` — the
 * same span `findActiveTournament` treats as "held."
 */
export async function renameTournament(prisma: PrismaClient, tournamentId: string, name: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    if (t.state === 'COMPLETE' || t.state === 'CANCELLED') {
      throw new TournamentTransitionError(tournamentId, `cannot rename, already ${t.state}`);
    }
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { name } });
    await logAction(tx, actorId, 'TOURNAMENT_RENAMED', 'Tournament', tournamentId, { from: t.name, to: name });
    return updated;
  });
}

/**
 * States in which `Tournament.defaultFormatKey` still means something.
 * `RUNNING` onward, the bracket is materialized and every match already
 * carries its own `formatKey` stamped at generation (`bracket-service.ts`) —
 * changing the tournament's default past that point would silently affect
 * nothing already on the board.
 */
const FORMAT_EDITABLE_STATES: readonly TournamentState[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
];

/**
 * Thrown by `setTournamentFormat` when the tournament's matches are not all
 * on one format and no `mode` resolved which way to go. Carries the
 * breakdown (`{ "bo3-protect-veto": 8, "bo5-protect-veto": 2 }`) so a client
 * can render it without a second fetch. See that function's own comment for
 * the three choices this puts to the TO.
 */
export class MixedFormatConflictError extends Error {
  constructor(
    readonly tournamentId: string,
    readonly breakdown: Record<string, number>,
  ) {
    super(`tournament ${tournamentId}: matches are mixed across formats (${JSON.stringify(breakdown)})`);
    this.name = 'MixedFormatConflictError';
  }
}

export type SetTournamentFormatMode = 'UPDATE_ALL' | 'DEFAULT_ONLY';

/**
 * The picker DESIGN.md's "Configurability" section anticipates: which
 * ruleset gets stamped onto every match this tournament generates by
 * default. Modelled directly on `renameTournament` below, but gated to
 * `FORMAT_EDITABLE_STATES` rather than "any non-terminal state" — unlike a
 * name, a format change after the bracket exists would be misleading rather
 * than merely late.
 *
 * A bracket can now exist well before `RUNNING` (`GENERATE_BRACKET`), so
 * "the default is editable" and "every match already agrees with it" are no
 * longer the same fact — a TO can generate at Bo3, hand-assign a few matches
 * to Bo5, and only then change the default. `mode` resolves what that means:
 * omitted, this throws `MixedFormatConflictError` the first time the matches
 * disagree, so a caller can put the choice to the TO; `'UPDATE_ALL'` stamps
 * every `PENDING` match and clears `formatOverrides` (otherwise they would
 * re-diverge on the next regeneration); `'DEFAULT_ONLY'` changes nothing but
 * the default, same as when nothing was mixed to begin with. "Cancel" is not
 * a mode — the caller simply doesn't call.
 */
export async function setTournamentFormat(
  prisma: PrismaClient,
  tournamentId: string,
  formatKey: string,
  actorId: string,
  mode?: SetTournamentFormatMode,
): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    if (!FORMAT_EDITABLE_STATES.includes(t.state)) {
      throw new TournamentTransitionError(tournamentId, `the bracket is already generated, so the format is locked (state is ${t.state})`);
    }
    requireFormat(formatKey); // throws on an unregistered key before it ever reaches the column.

    if (!mode) {
      const matches = await tx.match.findMany({ where: { tournamentId }, select: { formatKey: true } });
      const breakdown: Record<string, number> = {};
      for (const m of matches) breakdown[m.formatKey] = (breakdown[m.formatKey] ?? 0) + 1;
      if (Object.keys(breakdown).length > 1) {
        throw new MixedFormatConflictError(tournamentId, breakdown);
      }
    }

    if (mode === 'UPDATE_ALL') {
      // Every match this early is PENDING by construction (see
      // `generateBracketGraph`'s comment) — filtered anyway so this can never
      // touch a match that has since started, if that invariant is ever wrong.
      await tx.match.updateMany({ where: { tournamentId, status: 'PENDING' }, data: { formatKey } });
    }

    const updated = await tx.tournament.update({
      where: { id: tournamentId },
      data: { defaultFormatKey: formatKey, ...(mode === 'UPDATE_ALL' ? { formatOverrides: {} } : {}) },
    });
    await logAction(tx, actorId, 'TOURNAMENT_FORMAT_SET', 'Tournament', tournamentId, {
      from: t.defaultFormatKey,
      to: formatKey,
      mode: mode ?? 'DEFAULT_ONLY',
    });
    return updated;
  });
}

/**
 * Assigns `formatKey` to one match, a whole round, or an arbitrary
 * multi-selection — `refs` is just "however many matches this call
 * targets," so the bulk affordances (a round-heading control, a
 * multi-select) are different ways of building `refs`, not different code
 * paths. Writes both the durable intent (`Tournament.formatOverrides`) and
 * the `Match` rows it currently maps onto.
 *
 * Guarded on `PENDING` alone, not a lifecycle state — correcting a future
 * match's format works even once `RUNNING`, the one thing
 * `FORMAT_EDITABLE_STATES` (the *default's* gate) cannot express.
 */
/**
 * Editing a match's format is open from tournament creation up to the
 * moment it starts, then blocked for the rest of its life — same upper
 * bound `SEEDING_STATES`/`SONG_POOL_EDITABLE_STATES` use elsewhere. Once
 * `RUNNING`, a match already has real players and a Draw drawing from
 * whatever pool its format implies; once `COMPLETE`/`CANCELLED`, there's
 * nothing left to reformat at all.
 */
const MATCH_FORMAT_EDITABLE_STATES: readonly TournamentState[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
];

export async function setMatchFormats(
  prisma: PrismaClient,
  tournamentId: string,
  refs: MatchRef[],
  formatKey: string,
  actorId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    requireFormat(formatKey);
    const tournament = await requireStateIn(tx, tournamentId, MATCH_FORMAT_EDITABLE_STATES);
    const overrides: Record<string, string> = { ...(tournament.formatOverrides as Record<string, string>) };

    for (const ref of refs) {
      const match = await tx.match.findUnique({
        where: { tournamentId_bracket_round_slot: { tournamentId, bracket: ref.bracket, round: ref.round, slot: ref.slot } },
      });
      if (!match) throw new TournamentTransitionError(tournamentId, `no match at ${matchKey(ref)}`);
      if (match.status !== 'PENDING') {
        throw new TournamentTransitionError(tournamentId, `${matchKey(ref)} has already started, its format can't change`);
      }
      overrides[matchKey(ref)] = formatKey;
      await tx.match.update({ where: { id: match.id }, data: { formatKey } });
    }

    await tx.tournament.update({ where: { id: tournamentId }, data: { formatOverrides: overrides } });
    await logAction(tx, actorId, 'MATCH_FORMAT_SET', 'Tournament', tournamentId, { formatKey, matches: refs.map(matchKey) });
  });
}

export interface RegenerateBracketResult {
  tournament: Tournament;
  entrantCount: number;
  matchCount: number;
  assignmentsKept: number;
  overridesReset: boolean;
}

/**
 * `/tournament`'s "Generate Bracket" step and the web config page's matching
 * button — the graph half of what used to happen only at `start`, pulled
 * forward so a TO has real matches to assign formats to before pressing
 * Start. Idempotent: calling it again regenerates, per
 * `generateBracketGraph`'s resize rule.
 */
export async function regenerateBracket(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<RegenerateBracketResult> {
  return prisma.$transaction(async (tx) => {
    await requireState(tx, tournamentId, 'CHECKIN_CLOSED');
    const entrantCount = await tx.entrant.count({ where: { tournamentId, status: 'ACTIVE', checkedIn: true } });
    if (entrantCount < 2) {
      throw new TournamentTransitionError(tournamentId, `needs at least 2 checked-in entrants to generate a bracket, only has ${entrantCount}`);
    }
    const { bracket, overridesReset, assignmentsKept } = await generateBracketGraph(tx, tournamentId, entrantCount);
    const tournament = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    await logAction(tx, actorId, 'BRACKET_GENERATED', 'Tournament', tournamentId, {
      entrantCount,
      matchCount: bracket.matches.length,
      overridesReset,
    });
    return { tournament, entrantCount, matchCount: bracket.matches.length, assignmentsKept, overridesReset };
  });
}

/**
 * `REGISTRATION_OPEN → REGISTRATION_CLOSED`, and also `CHECKIN_OPEN →
 * REGISTRATION_CLOSED` — undoing an `open-checkin` that ran too early,
 * without needing a dedicated "reopen registration... but not really"
 * command. As with reopening check-in, no `Entrant` row is touched: whoever
 * had already checked in simply stays `checkedIn`, which matters again the
 * next time check-in closes for real.
 */
export async function closeRegistration(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    await requireStateIn(tx, tournamentId, ['REGISTRATION_OPEN', 'CHECKIN_OPEN']);
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'REGISTRATION_CLOSED' } });
    await logAction(tx, actorId, 'REGISTRATION_CLOSED', 'Tournament', tournamentId, {});
    return updated;
  });
}

/**
 * `REGISTRATION_CLOSED → CHECKIN_OPEN`, and also `CHECKIN_CLOSED →
 * CHECKIN_OPEN` — reopening is allowed, e.g. check-in was closed too early.
 * Reopening touches no `Entrant` row: anyone still `ACTIVE` and not yet
 * `checkedIn` (their seed already cleared, if `closeCheckin` had run) simply
 * becomes reachable by `/checkin` again, and the next `closeCheckin` folds
 * them back into the seed order exactly as it would have the first time.
 */
export async function openCheckin(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await requireStateIn(tx, tournamentId, ['REGISTRATION_CLOSED', 'CHECKIN_CLOSED']);
    await discardBracketIfReopening(tx, tournamentId, t.state);
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CHECKIN_OPEN' } });
    await logAction(tx, actorId, 'CHECKIN_OPENED', 'Tournament', tournamentId, {});
    return updated;
  });
}

/**
 * The drop-and-collapse that happens at tournament start, not check-in
 * close: "only players who complete check-in participate," so this clears
 * the seed of every active-but-not-checked-in entrant (freeing those
 * numbers — `entrant_seed_unique` is unconditional, not scoped to
 * `checkedIn`), then renumbers the survivors from 1 in their existing
 * relative seed order. Every survivor already holds a real seed by this
 * point — seeding runs continuously from the first `/join`
 * (`roster-service.ts`'s `joinOrReactivate`) — so the "unseeded, appended
 * in join order" branch only ever matters for data predating that
 * guarantee.
 *
 * One `UPDATE` per surviving entrant rather than a single set-based
 * statement — deliberately: `(tournamentId, seed)`'s uniqueness is a
 * `DEFERRABLE INITIALLY DEFERRED` constraint precisely so a whole reorder
 * can pass through intermediate, transiently colliding values and only be
 * checked as a batch at commit. See the initial migration's comment on
 * `entrant_seed_unique`.
 */
export async function renormalizeSeeds(tx: Tx, tournamentId: string): Promise<{ survivingCount: number }> {
  await tx.entrant.updateMany({
    where: { tournamentId, status: 'ACTIVE', checkedIn: false, seed: { not: null } },
    data: { seed: null },
  });

  const seeded = await tx.entrant.findMany({
    where: { tournamentId, status: 'ACTIVE', checkedIn: true, seed: { not: null } },
    orderBy: { seed: 'asc' },
  });
  const unseeded = await tx.entrant.findMany({
    where: { tournamentId, status: 'ACTIVE', checkedIn: true, seed: null },
    orderBy: { joinedAt: 'asc' },
  });

  let seed = 1;
  for (const e of [...seeded, ...unseeded]) {
    await tx.entrant.update({ where: { id: e.id }, data: { seed: seed++ } });
  }
  return { survivingCount: seeded.length + unseeded.length };
}

/**
 * A pure state transition — no seed mutation here. Seeding stays open
 * (see `roster-service.ts`'s `reorderSeeds`) all the way through
 * `CHECKIN_CLOSED`; dropping no-shows and collapsing the survivors'
 * seeds to 1..N is deferred to the moment the tournament actually
 * starts (`startTournament`'s own call to `renormalizeSeeds`), since
 * until then a late check-in or withdrawal can still change the field.
 */
export async function closeCheckin(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    await requireState(tx, tournamentId, 'CHECKIN_OPEN');
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CHECKIN_CLOSED' } });
    await logAction(tx, actorId, 'CHECKIN_CLOSED', 'Tournament', tournamentId, {});
    return updated;
  });
}

const CANCELLABLE_STATES: readonly TournamentState[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
  'RUNNING',
];

const CANCELLABLE_MATCH_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

export interface CancelTournamentResult {
  tournament: Tournament;
  /** Every match this cancellation force-completed as `CANCELLED` — empty unless the tournament was `RUNNING`. Matches already `COMPLETE` are untouched and keep their real result. */
  cancelledMatchIds: string[];
}

/**
 * `CANCELLED` is reachable from any pre-`COMPLETE` state, including
 * `RUNNING` — "for any number of reasons... a tournament may need to be
 * cancelled midway." Cancelling a `RUNNING` tournament additionally marks
 * every not-yet-`COMPLETE` match `CANCELLED` in the same transaction as the
 * tournament's own state flip — one atomic write, not a cascade a partial
 * failure could leave half-done. `COMPLETE` matches are left exactly as
 * they are: a finished result stands regardless of what happens to the
 * rest of the event.
 *
 * Closing each cancelled match's Discord thread (posting a note in it,
 * then archiving) is Discord I/O and belongs to the command layer, same
 * split as everywhere else in this file — this only returns which match
 * ids were cancelled so the caller can look up their `threadId`s.
 */
export async function cancelTournament(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<CancelTournamentResult> {
  return prisma.$transaction(async (tx) => {
    const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    if (!CANCELLABLE_STATES.includes(t.state)) {
      throw new TournamentTransitionError(tournamentId, `cannot cancel, already ${t.state}`);
    }

    let cancelledMatchIds: string[] = [];
    if (t.state === 'RUNNING') {
      const incomplete = await tx.match.findMany({
        where: { tournamentId, status: { in: [...CANCELLABLE_MATCH_STATUSES] } },
        select: { id: true },
      });
      cancelledMatchIds = incomplete.map((m) => m.id);
      if (cancelledMatchIds.length > 0) {
        await tx.match.updateMany({
          where: { id: { in: cancelledMatchIds } },
          data: { status: 'CANCELLED' },
        });
      }
    }

    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CANCELLED' } });
    await logAction(tx, actorId, 'TOURNAMENT_CANCELLED', 'Tournament', tournamentId, {
      fromState: t.state,
      matchesCancelled: cancelledMatchIds.length,
    });
    return { tournament: updated, cancelledMatchIds };
  });
}

export interface PackSizeWarning {
  recommended: number;
  actual: number;
}

export interface StartTournamentResult {
  tournament: Tournament;
  packSizeWarning: PackSizeWarning | null;
}

/**
 * `CHECKIN_CLOSED → RUNNING`. "At this moment the bot snapshots each
 * remaining entrant's display name as shown in the server; re-checks that
 * all required Discord permissions are still granted, blocking the start if
 * any are missing; warns if the song pack is below the recommended minimum,
 * without blocking; generates the bracket, creates the round 1 match
 * threads, and notifies players." See REQUIREMENTS.md, "Starting the
 * tournament".
 *
 * Only the DB/domain half of that lives here: dropping no-shows and
 * collapsing the survivors' seeds to 1..N (`renormalizeSeeds` — seeding
 * stays open, freely reorderable, all the way up to this exact moment, per
 * DESIGN.md, "Seeding"), the display-name snapshot, the pack-size warning,
 * and bracket materialization. The permission preflight and the
 * tier-role-overlap warning both need a live guild member/role list, so the
 * command handler runs those *before* calling this — a blocking preflight
 * failure should never reach here, since the state would be left unchanged
 * by a preflight rejection.
 *
 * `displayNames` maps `Entrant.id → display name as the server currently
 * shows them`, resolved by the caller (guild member cache). An entrant with
 * no entry keeps whatever `displayName` it already had.
 */
export async function startTournament(
  prisma: PrismaClient,
  random: RandomPort,
  tournamentId: string,
  displayNames: ReadonlyMap<string, string>,
  actorId: string,
): Promise<StartTournamentResult> {
  const packSizeWarning = await prisma.$transaction(async (tx) => {
    const t = await requireState(tx, tournamentId, 'CHECKIN_CLOSED');
    // "The start also asserts that every generated match's `formatKey`
    // resolves to a registered format." Every match is stamped from the
    // default or an override, so asserting both here covers every match
    // `materializeBracket` is about to create or reuse.
    const overrides = t.formatOverrides as Record<string, string>;
    const format = requireFormat(t.defaultFormatKey);
    for (const key of Object.values(overrides)) requireFormat(key);

    // Every static-pool format in play (HB-11/HB-13) needs a well-formed
    // labeled pool before Start — see NEW_FORMAT.md's "Song Pool" and the
    // plan's "Tabs persist independently of completion... Start Tournament
    // is the actual hard gate."
    for (const key of staticPoolFormatKeysInPlay(t.defaultFormatKey, overrides)) {
      const issues = await validateSongPool(tx, tournamentId, key);
      if (issues) {
        throw new TournamentTransitionError(tournamentId, `the "${key}" song pool isn't well-formed yet: ${songPoolIssuesSummary(issues)}`);
      }
    }

    const droppedForNoShow = await tx.entrant.count({ where: { tournamentId, status: 'ACTIVE', checkedIn: false } });
    const { survivingCount } = await renormalizeSeeds(tx, tournamentId);

    // A bracket generated ahead of start (`GENERATE_BRACKET`) is only valid
    // for the field it was built against — the same invariant
    // `discardBracketIfReopening` exists to protect on the way back out of
    // `CHECKIN_CLOSED`. Checked here too because check-in can also close a
    // *second* time onto a different field without ever reopening in
    // between (a referee-driven withdrawal, say) — nothing else re-validates
    // it right before the bracket rows are trusted. Silently regenerating
    // instead was considered and rejected: it would either strand a TO's
    // per-match assignments without them noticing, or (worse) reuse a
    // bracket built for the wrong field, per `entrantCountAtStart`'s own
    // comment on why this count must never drift from what was materialized.
    if (t.bracketEntrantCount !== null && t.bracketEntrantCount !== survivingCount) {
      throw new TournamentTransitionError(
        tournamentId,
        `the generated bracket was built for ${t.bracketEntrantCount} checked-in entrants, but ${survivingCount} remain — regenerate the bracket before starting`,
      );
    }

    // Both guarded *before* the state flips to RUNNING below — `generateBracket`
    // requires at least two entrants and `draw()` requires a non-empty pack;
    // either failing partway through `materializeBracket` (a separate
    // transaction — see the call below) would otherwise leave the tournament
    // stuck in RUNNING with no bracket and no way back through this state
    // machine, since every other transition requires a specific prior state.
    if (survivingCount < 2) {
      throw new TournamentTransitionError(tournamentId, `needs at least 2 checked-in entrants to start, only has ${survivingCount}`);
    }
    const chartCount = await tx.chart.count({ where: { tournamentId } });
    if (chartCount === 0) {
      throw new TournamentTransitionError(tournamentId, 'the chart pack is empty, import one before starting');
    }

    const active = await tx.entrant.findMany({ where: { tournamentId, status: 'ACTIVE', checkedIn: true } });
    for (const e of active) {
      const name = displayNames.get(e.id);
      if (name !== undefined && name !== e.displayName) {
        await tx.entrant.update({ where: { id: e.id }, data: { displayName: name } });
      }
    }

    await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'RUNNING' } });
    await logAction(tx, actorId, 'TOURNAMENT_STARTED', 'Tournament', tournamentId, { entrantCount: active.length, droppedForNoShow });

    // DESIGN.md, "Configurability": "once a tournament can mix formats, the
    // threshold is the maximum across those in use" — every format the
    // bracket will actually carry, not just the default.
    const recommendedPackSize = Math.max(format.recommendedPackSize, ...Object.values(overrides).map((k) => requireFormat(k).recommendedPackSize));
    return chartCount < recommendedPackSize ? { recommended: recommendedPackSize, actual: chartCount } : null;
  });

  // Materializes round 1 (and any bye cascade) as its own transaction, same
  // as the verification harness's call sequence — see `bracket-service.ts`.
  await materializeBracket(prisma, random, tournamentId);

  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  return { tournament, packSizeWarning };
}

/**
 * Legal next actions per state — a direct read of the `requireState`/
 * `requireStateIn` calls each transition above already makes; kept as its
 * own table here rather than derived, since scattering "is this legal"
 * across each function's own guard would need a second query per action to
 * answer "what's legal right now" instead of one. `START` appears only for
 * `CHECKIN_CLOSED` — this table names it as legal, but whether it actually
 * fires still depends on the live Discord permission preflight
 * `startTournamentWithDiscordEffects` runs, which nothing checkable from
 * Postgres alone (this table included) can predict.
 */
const LEGAL_ACTIONS: Record<TournamentState, LifecycleAction[]> = {
  DRAFT: ['OPEN_REGISTRATION', 'RENAME', 'CANCEL'],
  REGISTRATION_OPEN: ['CLOSE_REGISTRATION', 'RENAME', 'CANCEL'],
  REGISTRATION_CLOSED: ['OPEN_REGISTRATION', 'OPEN_CHECKIN', 'RENAME', 'CANCEL'],
  CHECKIN_OPEN: ['OPEN_REGISTRATION', 'CLOSE_REGISTRATION', 'CLOSE_CHECKIN', 'RENAME', 'CANCEL'],
  CHECKIN_CLOSED: ['OPEN_REGISTRATION', 'OPEN_CHECKIN', 'START', 'GENERATE_BRACKET', 'RENAME', 'CANCEL'],
  RUNNING: ['RENAME', 'CANCEL'],
  COMPLETE: [],
  CANCELLED: [],
};

/**
 * DESIGN.md, "Everything else": "current state, the transitions currently
 * legal, and each one's guard shown as a checklist so a TO can see what is
 * blocking a start before pressing it." `startGuards` covers everything
 * checkable from Postgres alone — the live Discord permission preflight
 * `/tournament start` also runs isn't included; see `LifecycleStatus`.
 */
export async function getLifecycleStatus(prisma: PrismaClient, tournamentId: string): Promise<LifecycleStatus> {
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  const guild = await prisma.guild.findUnique({ where: { id: tournament.guildId } });

  const [checkedInCount, chartCount] = await Promise.all([
    prisma.entrant.count({ where: { tournamentId, status: 'ACTIVE', checkedIn: true } }),
    prisma.chart.count({ where: { tournamentId } }),
  ]);

  // Only meaningful once a bracket exists — `null` means nothing has been
  // generated yet, which is not a problem: Start still works by generating
  // fresh, exactly as it always has. See `materializeBracket`.
  const bracketOk = tournament.bracketEntrantCount === null || tournament.bracketEntrantCount === checkedInCount;

  // One guard per static-pool format in play, mirroring `startTournament`'s
  // own hard check — surfaced ahead of time so a TO can see exactly which
  // pool (and which labels) still need attention before pressing Start.
  const staticPoolKeys = staticPoolFormatKeysInPlay(
    tournament.defaultFormatKey,
    tournament.formatOverrides as Record<string, string>,
  );
  const staticPoolGuards = await Promise.all(
    staticPoolKeys.map(async (key) => {
      const issues = await validateSongPool(prisma, tournamentId, key);
      return {
        label: issues ? `Song pool "${key}" isn't well-formed: ${songPoolIssuesSummary(issues)}` : `Song pool "${key}" is well-formed`,
        ok: !issues,
      };
    }),
  );

  return {
    state: tournament.state,
    name: tournament.name,
    legalActions: LEGAL_ACTIONS[tournament.state],
    startGuards: [
      { label: 'Server is fully configured (channels and roles)', ok: missingGuildConfig(guild).length === 0 },
      { label: 'At least 2 checked-in entrants', ok: checkedInCount >= 2 },
      { label: 'Chart pack has at least 1 chart', ok: chartCount > 0 },
      {
        label: bracketOk
          ? 'Bracket matches the checked-in field'
          : `Bracket is stale (built for ${tournament.bracketEntrantCount}, ${checkedInCount} checked in now) — regenerate it`,
        ok: bracketOk,
      },
      ...staticPoolGuards,
    ],
    defaultFormatKey: tournament.defaultFormatKey as LifecycleStatus['defaultFormatKey'],
    formatEditable: FORMAT_EDITABLE_STATES.includes(tournament.state),
    bracketEntrantCount: tournament.bracketEntrantCount,
  };
}
