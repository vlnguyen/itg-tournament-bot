import { Prisma, type Guild, type PrismaClient, type Tournament, type TournamentState } from '@prisma/client';
import { DEFAULT_TOURNAMENT_CONFIG } from '@itg/shared';
import { Bo5ProtectVetoFormat } from '../domain/bo5.js';
import { logAction } from './audit-log.js';
import { materializeBracket } from './bracket-service.js';
import { requireFormat, type Tx } from './engine.js';
import type { RandomPort } from './ports.js';

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

export class TournamentTransitionError extends Error {
  constructor(
    readonly tournamentId: string,
    readonly reason: string,
  ) {
    super(`tournament ${tournamentId}: ${reason}`);
    this.name = 'TournamentTransitionError';
  }
}

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
function missingGuildConfig(guild: Guild | null): string[] {
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
 * `DRAFT → REGISTRATION_OPEN`, and also `REGISTRATION_CLOSED →
 * REGISTRATION_OPEN` — reopening, same reasoning as reopening check-in: a TO
 * who closed registration too early runs this again rather than needing a
 * dedicated "reopen" command. No "another tournament active" check here any
 * more — `createTournament` already guarantees this tournament is the only
 * non-terminal one this guild has, so there is nothing left to race against
 * by the time this transition runs.
 */
export async function openRegistration(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await requireStateIn(tx, tournamentId, ['DRAFT', 'REGISTRATION_CLOSED']);
    requireFormat(t.defaultFormatKey); // "format chosen" — cannot fail today; see DESIGN.md's note on the same assertion at start.

    const guild = await tx.guild.findUnique({ where: { id: t.guildId } });
    const missing = missingGuildConfig(guild);
    if (missing.length > 0) {
      throw new TournamentTransitionError(tournamentId, `this server isn't fully configured yet — missing: ${missing.join(', ')}. Run /setup.`);
    }

    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'REGISTRATION_OPEN' } });
    await logAction(tx, actorId, 'REGISTRATION_OPENED', 'Tournament', tournamentId, {});
    return updated;
  });
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
      throw new TournamentTransitionError(tournamentId, `cannot rename — it is already ${t.state}`);
    }
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { name } });
    await logAction(tx, actorId, 'TOURNAMENT_RENAMED', 'Tournament', tournamentId, { from: t.name, to: name });
    return updated;
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
    await requireStateIn(tx, tournamentId, ['REGISTRATION_CLOSED', 'CHECKIN_CLOSED']);
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CHECKIN_OPEN' } });
    await logAction(tx, actorId, 'CHECKIN_OPENED', 'Tournament', tournamentId, {});
    return updated;
  });
}

/**
 * Clears the seed of every active-but-not-checked-in entrant, then
 * renumbers the survivors from 1: currently-seeded ones first (preserving
 * their relative order), unseeded ones appended after in join order. Shared
 * by `closeCheckin` (the ordinary case, every active entrant is
 * "surviving" by definition since check-in hasn't dropped anyone yet — see
 * below) and by `roster-service.ts`'s late-withdrawal/late-checkin paths,
 * which "re-run normalization immediately" per DESIGN.md, "Leaving" and
 * "Acting on a player's behalf".
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
 * "Un-checked-in entrants have their seeds cleared; surviving seeds
 * renumbered from 1 in relative order; unseeded entrants appended in join
 * order — one transaction. No status changes: `checkedIn` already records
 * who was dropped." See DESIGN.md's lifecycle table and REQUIREMENTS.md,
 * "Seeding".
 */
export async function closeCheckin(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    await requireState(tx, tournamentId, 'CHECKIN_OPEN');

    const { survivingCount } = await renormalizeSeeds(tx, tournamentId);

    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CHECKIN_CLOSED' } });
    await logAction(tx, actorId, 'CHECKIN_CLOSED', 'Tournament', tournamentId, {
      survivingEntrants: survivingCount,
      droppedForNoShow: await tx.entrant.count({ where: { tournamentId, status: 'ACTIVE', checkedIn: false } }),
    });
    return updated;
  });
}

const CANCELLABLE_STATES: readonly TournamentState[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'CHECKIN_OPEN',
  'CHECKIN_CLOSED',
];

/** "`CANCELLED` is reachable from any pre-`RUNNING` state at Tournament Organizer tier, and frees the guild's active slot." */
export async function cancelTournament(prisma: PrismaClient, tournamentId: string, actorId: string): Promise<Tournament> {
  return prisma.$transaction(async (tx) => {
    const t = await tx.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    if (!CANCELLABLE_STATES.includes(t.state)) {
      throw new TournamentTransitionError(tournamentId, `cannot cancel — it is already ${t.state}`);
    }
    const updated = await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'CANCELLED' } });
    await logAction(tx, actorId, 'TOURNAMENT_CANCELLED', 'Tournament', tournamentId, { fromState: t.state });
    return updated;
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
 * Only the DB/domain half of that lives here: the seed-contiguity assertion
 * (normalization at check-in close already guarantees it; a violation means
 * that step is broken), the display-name snapshot, the pack-size warning,
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
    // resolves to a registered format." Every match is stamped from this
    // one default, so asserting it here covers every match `materializeBracket`
    // is about to create.
    const format = requireFormat(t.defaultFormatKey);

    const active = await tx.entrant.findMany({ where: { tournamentId, status: 'ACTIVE', checkedIn: true } });
    const seeds = active.map((e) => e.seed).sort((a, b) => (a ?? 0) - (b ?? 0));
    const contiguous = active.every((e) => e.seed !== null) && seeds.every((s, i) => s === i + 1);
    if (!contiguous) {
      throw new TournamentTransitionError(
        tournamentId,
        'active entrants are not seeded 1..N contiguously — close-checkin should have normalized this; refusing to start on a broken invariant',
      );
    }

    // Both guarded *before* the state flips to RUNNING below — `generateBracket`
    // requires at least two entrants and `draw()` requires a non-empty pack;
    // either failing partway through `materializeBracket` (a separate
    // transaction — see the call below) would otherwise leave the tournament
    // stuck in RUNNING with no bracket and no way back through this state
    // machine, since every other transition requires a specific prior state.
    if (active.length < 2) {
      throw new TournamentTransitionError(tournamentId, `needs at least 2 checked-in entrants to start — has ${active.length}`);
    }
    const chartCount = await tx.chart.count({ where: { tournamentId } });
    if (chartCount === 0) {
      throw new TournamentTransitionError(tournamentId, 'the chart pack is empty — import a pack before starting');
    }

    for (const e of active) {
      const name = displayNames.get(e.id);
      if (name !== undefined && name !== e.displayName) {
        await tx.entrant.update({ where: { id: e.id }, data: { displayName: name } });
      }
    }

    await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'RUNNING' } });
    await logAction(tx, actorId, 'TOURNAMENT_STARTED', 'Tournament', tournamentId, { entrantCount: active.length });

    return chartCount < format.recommendedPackSize ? { recommended: format.recommendedPackSize, actual: chartCount } : null;
  });

  // Materializes round 1 (and any bye cascade) as its own transaction, same
  // as the verification harness's call sequence — see `bracket-service.ts`.
  await materializeBracket(prisma, random, tournamentId);

  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
  return { tournament, packSizeWarning };
}
