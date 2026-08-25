import type { Entrant, PrismaClient, Tournament, TournamentState } from '@prisma/client';
import { logAction } from './audit-log.js';
import type { Tx } from './engine.js';
import { findActiveTournament, renormalizeSeeds } from './tournament-service.js';

/**
 * `/join`, `/checkin`, `/leave`, and `/roster`'s on-behalf equivalents — see
 * DESIGN.md, "Registration and Check-in". "Expected failures are states,
 * not errors" (DESIGN.md, "Failure Handling"): every outcome the command
 * table enumerates — no tournament, wrong window, already in that state,
 * not on the roster — is a tagged result, not a thrown error. The command
 * layer turns each `kind` into the right ephemeral reply.
 *
 * "On-behalf actions are indistinguishable in the data... Checking a player
 * in as an organizer writes exactly what `/checkin` writes; removing them
 * writes exactly what `/leave` writes." So every self-service function here
 * shares its core mutation with its `/roster` counterpart; what differs is
 * the window each is allowed in, whether it logs to `AuditLog`, and (for
 * withdrawal) whether it needs an organizer alert.
 */

function entrantWhere(tournamentId: string, discordUserId: string) {
  return { tournamentId_discordUserId: { tournamentId, discordUserId } };
}

// ---------------------------------------------------------------------------
// join / roster add
// ---------------------------------------------------------------------------

export type JoinOutcome = { kind: 'JOINED'; entrant: Entrant } | { kind: 'ALREADY_JOINED'; entrant: Entrant };

/**
 * Creates the entrant if none exists; reactivates one that previously
 * withdrew (status back to `ACTIVE`, `checkedIn` and `seed` reset, `joinedAt`
 * bumped to now — "the state that would have existed had the player [joined]
 * during the window", same reasoning DESIGN.md gives for the late-checkin
 * path below). Already-`ACTIVE` is not an error: "a player who is not sure
 * whether their `/join` landed will run it again, and an error is a worse
 * answer than 'you are in, seed 12.'"
 */
async function joinOrReactivate(tx: Tx, tournamentId: string, discordUserId: string): Promise<JoinOutcome> {
  const existing = await tx.entrant.findUnique({ where: entrantWhere(tournamentId, discordUserId) });
  if (existing?.status === 'ACTIVE') return { kind: 'ALREADY_JOINED', entrant: existing };

  const entrant = existing
    ? await tx.entrant.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', checkedIn: false, seed: null, joinedAt: new Date() },
      })
    : await tx.entrant.create({ data: { tournamentId, discordUserId } });
  return { kind: 'JOINED', entrant };
}

export type JoinResult = JoinOutcome | { kind: 'NO_TOURNAMENT' } | { kind: 'WINDOW_CLOSED'; phase: TournamentState };

export async function joinTournament(prisma: PrismaClient, guildId: string, discordUserId: string): Promise<JoinResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (tournament.state !== 'REGISTRATION_OPEN') return { kind: 'WINDOW_CLOSED', phase: tournament.state };
    return joinOrReactivate(tx, tournament.id, discordUserId);
  });
}

/** "`/join` closes when registration closes; a TO can still add someone who missed it, right up until the bracket is generated." */
const ROSTER_ADD_STATES: readonly TournamentState[] = ['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'CHECKIN_OPEN', 'CHECKIN_CLOSED'];

export type RosterAddResult = JoinOutcome | { kind: 'NO_TOURNAMENT' } | { kind: 'TOO_LATE'; phase: TournamentState };

export async function rosterAdd(
  prisma: PrismaClient,
  guildId: string,
  discordUserId: string,
  actorId: string,
): Promise<RosterAddResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (!ROSTER_ADD_STATES.includes(tournament.state)) return { kind: 'TOO_LATE', phase: tournament.state };

    const outcome = await joinOrReactivate(tx, tournament.id, discordUserId);
    if (outcome.kind === 'JOINED') {
      await logAction(tx, actorId, 'ROSTER_ADD', 'Entrant', outcome.entrant.id, { discordUserId });
    }
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// checkin / roster checkin
// ---------------------------------------------------------------------------

export type CheckinOutcome = { kind: 'CHECKED_IN'; entrant: Entrant } | { kind: 'ALREADY_CHECKED_IN'; entrant: Entrant };

export type CheckinResult =
  | CheckinOutcome
  | { kind: 'NO_TOURNAMENT' }
  | { kind: 'WINDOW_CLOSED'; phase: TournamentState }
  | { kind: 'NOT_REGISTERED' };

export async function checkin(prisma: PrismaClient, guildId: string, discordUserId: string): Promise<CheckinResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (tournament.state !== 'CHECKIN_OPEN') return { kind: 'WINDOW_CLOSED', phase: tournament.state };

    const entrant = await tx.entrant.findUnique({ where: entrantWhere(tournament.id, discordUserId) });
    if (!entrant || entrant.status !== 'ACTIVE') return { kind: 'NOT_REGISTERED' };
    if (entrant.checkedIn) return { kind: 'ALREADY_CHECKED_IN', entrant };

    const updated = await tx.entrant.update({ where: { id: entrant.id }, data: { checkedIn: true } });
    return { kind: 'CHECKED_IN', entrant: updated };
  });
}

const ROSTER_CHECKIN_STATES: readonly TournamentState[] = ['CHECKIN_OPEN', 'CHECKIN_CLOSED'];

export type RosterCheckinResult =
  | CheckinOutcome
  | { kind: 'NO_TOURNAMENT' }
  | { kind: 'WINDOW_CLOSED'; phase: TournamentState }
  | { kind: 'NOT_REGISTERED' };

/**
 * "A player cannot check themselves in after check-in closes, so what
 * should an organizer doing it produce? ... The state that would have
 * existed had the player checked in during the window: `checkedIn` true,
 * status back to `ACTIVE`, and appended unseeded in join order so the next
 * normalization folds them into the order." Reactivates a withdrawn entrant
 * the same way `rosterAdd` does; when the tournament is already
 * `CHECKIN_CLOSED`, re-runs `renormalizeSeeds` immediately rather than
 * waiting for a normalization pass that already happened.
 */
export async function rosterCheckin(
  prisma: PrismaClient,
  guildId: string,
  discordUserId: string,
  actorId: string,
): Promise<RosterCheckinResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (!ROSTER_CHECKIN_STATES.includes(tournament.state)) return { kind: 'WINDOW_CLOSED', phase: tournament.state };

    const entrant = await tx.entrant.findUnique({ where: entrantWhere(tournament.id, discordUserId) });
    if (!entrant) return { kind: 'NOT_REGISTERED' };
    if (entrant.status === 'ACTIVE' && entrant.checkedIn) return { kind: 'ALREADY_CHECKED_IN', entrant };

    const wasWithdrawn = entrant.status === 'WITHDRAWN';
    const updated = await tx.entrant.update({
      where: { id: entrant.id },
      data: wasWithdrawn
        ? { status: 'ACTIVE', checkedIn: true, seed: null, joinedAt: new Date() }
        : { checkedIn: true },
    });
    await logAction(tx, actorId, 'ROSTER_CHECKIN', 'Entrant', entrant.id, { discordUserId, reactivated: wasWithdrawn });

    if (tournament.state === 'CHECKIN_CLOSED') {
      await renormalizeSeeds(tx, tournament.id);
    }
    return { kind: 'CHECKED_IN', entrant: updated };
  });
}

// ---------------------------------------------------------------------------
// roster uncheckin (no self-service equivalent)
// ---------------------------------------------------------------------------

export type RosterUncheckinResult =
  | { kind: 'UNCHECKED_IN'; entrant: Entrant }
  | { kind: 'ALREADY_NOT_CHECKED_IN'; entrant: Entrant }
  | { kind: 'NO_TOURNAMENT' }
  | { kind: 'TOO_LATE'; phase: TournamentState }
  | { kind: 'NOT_REGISTERED' };

/**
 * The reverse of `rosterCheckin`, with no self-service equivalent — DESIGN.md
 * only ever describes the organizer using it. When the tournament is already
 * `CHECKIN_CLOSED`, an un-checkin changes who counts as the seeded field the
 * same way a late withdrawal or late checkin does, so it re-runs
 * `renormalizeSeeds` for the same reason — not spelled out verbatim in
 * DESIGN.md, but the direct completion of "late additions and re-check-ins
 * re-run normalization, exactly as late withdrawals do."
 */
export async function rosterUncheckin(
  prisma: PrismaClient,
  guildId: string,
  discordUserId: string,
  actorId: string,
): Promise<RosterUncheckinResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (tournament.state === 'RUNNING') return { kind: 'TOO_LATE', phase: tournament.state };

    const entrant = await tx.entrant.findUnique({ where: entrantWhere(tournament.id, discordUserId) });
    if (!entrant || entrant.status !== 'ACTIVE') return { kind: 'NOT_REGISTERED' };
    if (!entrant.checkedIn) return { kind: 'ALREADY_NOT_CHECKED_IN', entrant };

    const updated = await tx.entrant.update({ where: { id: entrant.id }, data: { checkedIn: false, seed: null } });
    await logAction(tx, actorId, 'ROSTER_UNCHECKIN', 'Entrant', entrant.id, { discordUserId });

    if (tournament.state === 'CHECKIN_CLOSED') {
      await renormalizeSeeds(tx, tournament.id);
    }
    return { kind: 'UNCHECKED_IN', entrant: updated };
  });
}

// ---------------------------------------------------------------------------
// leave / roster remove
// ---------------------------------------------------------------------------

async function withdraw(tx: Tx, tournament: Tournament, entrant: Entrant): Promise<{ entrant: Entrant; alertNeeded: boolean }> {
  const updated = await tx.entrant.update({ where: { id: entrant.id }, data: { status: 'WITHDRAWN', seed: null } });

  // "Before check-in closes... a withdrawal is silent... Seed gaps do not
  // matter yet." "After check-in closes... a withdrawal re-runs the
  // normalization immediately... and raises an organizer alert."
  if (tournament.state !== 'CHECKIN_CLOSED') {
    return { entrant: updated, alertNeeded: false };
  }
  await renormalizeSeeds(tx, tournament.id);
  return { entrant: updated, alertNeeded: true };
}

export type LeaveResult =
  | { kind: 'LEFT'; entrant: Entrant; alertNeeded: boolean }
  | { kind: 'NO_TOURNAMENT' }
  | { kind: 'TOURNAMENT_RUNNING' }
  | { kind: 'NOT_REGISTERED' };

/** "`/leave` works from the moment registration opens until the tournament starts... Once the tournament starts, leaving requires a referee." */
export async function leaveTournament(prisma: PrismaClient, guildId: string, discordUserId: string): Promise<LeaveResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (tournament.state === 'RUNNING') return { kind: 'TOURNAMENT_RUNNING' };

    const entrant = await tx.entrant.findUnique({ where: entrantWhere(tournament.id, discordUserId) });
    if (!entrant || entrant.status !== 'ACTIVE') return { kind: 'NOT_REGISTERED' };

    const { entrant: updated, alertNeeded } = await withdraw(tx, tournament, entrant);
    return { kind: 'LEFT', entrant: updated, alertNeeded };
  });
}

export type RosterRemoveResult =
  | { kind: 'REMOVED'; entrant: Entrant }
  | { kind: 'NO_TOURNAMENT' }
  | { kind: 'TOO_LATE'; phase: TournamentState }
  | { kind: 'NOT_REGISTERED' };

/**
 * "Removing them writes exactly what `/leave` writes" — same `withdraw`
 * core — but never raises the late-withdrawal alert: "the organizer already
 * knows what they just did, and an alert reporting it is noise." Always
 * audit-logged, unlike self-service `/leave`, which is ordinary player
 * activity rather than an organizer action worth a permanent record.
 */
export async function rosterRemove(
  prisma: PrismaClient,
  guildId: string,
  discordUserId: string,
  actorId: string,
): Promise<RosterRemoveResult> {
  return prisma.$transaction(async (tx) => {
    const tournament = await findActiveTournament(tx, guildId);
    if (!tournament) return { kind: 'NO_TOURNAMENT' };
    if (tournament.state === 'RUNNING') return { kind: 'TOO_LATE', phase: tournament.state };

    const entrant = await tx.entrant.findUnique({ where: entrantWhere(tournament.id, discordUserId) });
    if (!entrant || entrant.status !== 'ACTIVE') return { kind: 'NOT_REGISTERED' };

    const { entrant: updated } = await withdraw(tx, tournament, entrant);
    await logAction(tx, actorId, 'ROSTER_REMOVE', 'Entrant', entrant.id, { discordUserId });
    return { kind: 'REMOVED', entrant: updated };
  });
}
