import type { Prisma } from '@prisma/client';
import type { ChartSnapshot } from '@itg/shared';
import { comparePoolLabels } from '@itg/shared';
import { draw } from '../domain/draw.js';
import { makeRng } from '../domain/rng.js';
import { formatRegistry } from '../domain/golden/registry.js';
import { generateBracket, liveSourceCount, type GeneratedBracket, type MatchRef } from '../domain/bracket.js';
import { grandFinalNeedsReset, routeCompletedMatch } from '../domain/advancement.js';
import { emptyState } from '../domain/types.js';
import type { MatchEvent, MatchFormat, MatchState } from '../domain/types.js';
import type { RandomPort } from './ports.js';

/**
 * The transactional core every service in this package builds on. Not a
 * public API by itself — `match-service.ts`, `bracket-service.ts`, and
 * `advancement-service.ts` compose these functions, always inside one
 * `prisma.$transaction`. See DESIGN.md, "Concurrency, Ordering, and
 * Idempotency" and "Advancement, Walkovers, and Standings".
 */

export type Tx = Prisma.TransactionClient;

/**
 * Defined here rather than in `tournament-service.ts` (which re-exports it,
 * so every existing import path is unaffected) so `bracket-service.ts` can
 * throw it too, without a cycle: both already import from this module, and
 * neither the reverse.
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

export function requireFormat(formatKey: string): MatchFormat {
  const format = formatRegistry[formatKey];
  if (!format) throw new Error(`unknown match format "${formatKey}"`);
  return format;
}

function toDomainEvent(row: {
  seq: number;
  actorId: string | null;
  type: string;
  payload: unknown;
}): MatchEvent {
  return { seq: row.seq, actorId: row.actorId, type: row.type, payload: row.payload } as MatchEvent;
}

/**
 * Every count feeding `generateBracket` must be the field size **as it was
 * when the bracket was materialized**, not how many entrants are currently
 * `ACTIVE` — a mid-tournament withdrawal must not reshape the graph. Seeds
 * are assigned once, at start, and (per DESIGN.md, "Bracket immutability is
 * enforced by the state") never mutate afterwards, so "has a seed" is the
 * stable count; "is still ACTIVE" is not.
 *
 * Once a bracket has been generated ahead of start (`Tournament.bracketEntrantCount`
 * is set), that recorded count is authoritative instead — the same
 * "materialized" moment this function has always deferred to, just moved
 * earlier. `generateBracketGraph` (`bracket-service.ts`) is the only writer
 * of that column, always alongside the `Match` rows it stamps, so the two
 * can't disagree.
 */
export async function entrantCountAtStart(tx: Tx, tournamentId: string): Promise<number> {
  const tournament = await tx.tournament.findUnique({
    where: { id: tournamentId },
    select: { bracketEntrantCount: true },
  });
  if (tournament?.bracketEntrantCount != null) return tournament.bracketEntrantCount;
  return tx.entrant.count({ where: { tournamentId, seed: { not: null } } });
}

/**
 * `SELECT ... FOR UPDATE` on the `Match` row, then the state it implies.
 * Every state-changing action serializes through this lock — see
 * DESIGN.md's transaction sketch. State comes from the cached `state`/
 * `stateSeq` columns when the cache is fresh; otherwise it is replayed,
 * which is also what makes the JSON column safe to treat as disposable.
 */
export async function lockAndLoadMatch(
  tx: Tx,
  matchId: string,
): Promise<{
  match: NonNullable<Awaited<ReturnType<Tx['match']['findUnique']>>>;
  state: MatchState;
  format: MatchFormat;
  ref: MatchRef;
}> {
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  const format = requireFormat(match.formatKey);
  const ref: MatchRef = { bracket: match.bracket, round: match.round, slot: match.slot };

  const agg = await tx.matchEvent.aggregate({ where: { matchId }, _max: { seq: true } });
  const maxSeq = agg._max.seq ?? 0;

  let state: MatchState;
  if (match.state != null && match.stateSeq === maxSeq) {
    state = match.state as unknown as MatchState;
  } else {
    const rows = await tx.matchEvent.findMany({ where: { matchId }, orderBy: { seq: 'asc' } });
    state = rows.reduce((s, row) => format.reduce(s, toDomainEvent(row)), emptyState());
  }

  return { match, state, format, ref };
}

/** Inserts one `MatchEvent` and folds it. No projection persistence — batched by `persistAndCascade`. */
export async function appendOne(
  tx: Tx,
  matchId: string,
  state: MatchState,
  format: MatchFormat,
  event: Omit<MatchEvent, 'seq'>,
  dedupeKey?: string | null,
): Promise<MatchState> {
  const seq = state.seq + 1;
  await tx.matchEvent.create({
    data: {
      matchId,
      seq,
      type: event.type,
      payload: event.payload as unknown as Prisma.InputJsonValue,
      actorId: event.actorId,
      dedupeKey: dedupeKey ?? null,
    },
  });
  const full = { ...event, seq } as MatchEvent;
  return format.reduce(state, full);
}

function toChartSnapshot(
  c: {
    id: string;
    title: string;
    titleTranslit: string | null;
    subtitle: string | null;
    subtitleTranslit: string | null;
    artist: string | null;
    artistTranslit: string | null;
    playStyle: ChartSnapshot['playStyle'];
    difficulty: ChartSnapshot['difficulty'];
    meter: number;
    stepartist: string | null;
    description: string | null;
    sourcePack: string | null;
    flags: unknown;
  },
  poolLabel: string | null = null,
): ChartSnapshot {
  return {
    chartId: c.id,
    title: c.title,
    titleTranslit: c.titleTranslit,
    subtitle: c.subtitle,
    subtitleTranslit: c.subtitleTranslit,
    artist: c.artist,
    artistTranslit: c.artistTranslit,
    playStyle: c.playStyle,
    difficulty: c.difficulty,
    meter: c.meter,
    stepartist: c.stepartist,
    description: c.description,
    sourcePack: c.sourcePack,
    flags: c.flags as ChartSnapshot['flags'],
    poolLabel,
  };
}

async function loadChartPack(tx: Tx, tournamentId: string): Promise<ChartSnapshot[]> {
  const charts = await tx.chart.findMany({ where: { tournamentId } });
  return charts.map((c) => toChartSnapshot(c));
}

/**
 * A static-pool format's Draw: every `ChartLabel` row for this tournament
 * and format, joined to its `Chart` — not random, unlike `loadChartPack` +
 * `draw()`. Only ever returns labeled charts; an unlabeled chart in the
 * same pack is never part of the pool. Ordered by `comparePoolLabels`
 * (category first — RD, FT, FN, TB — then numerically within one) rather
 * than a plain string sort, which is the canonical order every render of
 * this Draw (the "Song Pool" embed, veto/pick status lines) reads
 * top-to-bottom, position-in-the-array, no separate sort of its own. See
 * `hubert.ts`'s `DRAW_STATIC` directive.
 */
async function loadStaticPool(tx: Tx, tournamentId: string, formatKey: string): Promise<ChartSnapshot[]> {
  const labels = await tx.chartLabel.findMany({
    where: { tournamentId, formatKey },
    include: { chart: true },
  });
  labels.sort((a, b) => comparePoolLabels(a.label, b.label));
  return labels.map((l) => toChartSnapshot(l.chart, l.label));
}

/**
 * Runs the bot's side of the set — drawing, and starting the next song when
 * play order leaves nothing for a person to decide — until a person is back
 * on the clock. Mirrors `domain/testkit.ts`'s `MatchDriver.settle()`, but
 * sourcing the pack from the tournament's charts and seeds from `RandomPort`
 * instead of test fixtures.
 */
export async function settleBotLoop(
  tx: Tx,
  tournamentId: string,
  random: RandomPort,
  matchId: string,
  state: MatchState,
  format: MatchFormat,
): Promise<MatchState> {
  let steps = 0;
  for (;;) {
    const pending = format.pendingAction(state);
    if (pending.kind !== 'AWAITING_BOT') return state;
    if (++steps > 200) {
      throw new Error(`match ${matchId}: bot directive loop did not settle`);
    }
    const d = pending.directive;

    if (d.do === 'DRAW') {
      const pack = await loadChartPack(tx, tournamentId);
      const seed = random.newSeed();
      const event: Omit<MatchEvent, 'seq'> = {
        actorId: null,
        type: 'DRAW_MADE',
        payload: { seed, charts: draw(pack, d.count, () => true, seed) },
      };
      state = await appendOne(tx, matchId, state, format, event);
      continue;
    }

    if (d.do === 'DRAW_TIEBREAK') {
      const pack = await loadChartPack(tx, tournamentId);
      const seen = new Set([
        ...state.draw.map((c) => c.chartId),
        ...state.tiebreaks.flatMap((t) => t.charts.map((c) => c.chartId)),
      ]);
      const seed = random.newSeed();
      const event: Omit<MatchEvent, 'seq'> = {
        actorId: null,
        type: 'TIEBREAK_DRAWN',
        payload: { round: d.round, seed, charts: draw(pack, d.count, (c) => !seen.has(c.chartId), seed) },
      };
      state = await appendOne(tx, matchId, state, format, event);
      continue;
    }

    if (d.do === 'DRAW_STATIC') {
      const charts = await loadStaticPool(tx, tournamentId, format.key);
      const event: Omit<MatchEvent, 'seq'> = {
        actorId: null,
        type: 'DRAW_MADE',
        payload: { seed: 'static', charts },
      };
      state = await appendOne(tx, matchId, state, format, event);
      continue;
    }

    if (d.do === 'RANDOM_SIDE_ASSIGN') {
      const seed = random.newSeed();
      const [x, y] = state.participants.map((p) => p.entrantId);
      const aFirst = makeRng(seed).nextInt(2) === 0;
      const event: Omit<MatchEvent, 'seq'> = {
        actorId: null,
        type: 'SIDES_ASSIGNED',
        payload: aFirst ? { seed, a: x!, b: y! } : { seed, a: y!, b: x! },
      };
      state = await appendOne(tx, matchId, state, format, event);
      continue;
    }

    // d.do === 'START_SONG'
    const songIndex = state.songs.length;
    const chart =
      d.drawIndex !== undefined
        ? state.draw[d.drawIndex]!
        : state.tiebreaks.find((t) => t.round === d.tiebreakRound)!.charts[d.chartIndex!]!;
    const event: Omit<MatchEvent, 'seq'> = {
      actorId: null,
      type: 'SONG_STARTED',
      payload: {
        songIndex,
        chart,
        source: d.source,
        ...(d.drawIndex !== undefined ? { drawIndex: d.drawIndex } : {}),
        ...(d.tiebreakRound !== undefined ? { tiebreakRound: d.tiebreakRound } : {}),
      },
    };
    state = await appendOne(tx, matchId, state, format, event);
  }
}

function currentChartIdOf(state: MatchState): string | null {
  const active = state.songs.find((s) => !s.result);
  return active?.chart.chartId ?? null;
}

/**
 * Persists `state`/`stateSeq` and the projection columns for one match, and
 * — if `outcome()` just became non-null — runs the advancement cascade in
 * the same transaction: placements route into whatever they fill next
 * (`routeCompletedMatch`), each fill's `MatchParticipant` row is written,
 * and a match that just reached two seated participants is started (or
 * walked over, if one of them has since withdrawn) via `maybeStartMatch`.
 *
 * Lock ordering for any matches touched beyond `matchId` itself: always the
 * completed match first (already locked by the caller), then its
 * downstream fills, following the `WINNER_OF`/`LOSER_OF` edge direction —
 * never the reverse. Two concurrent completions feeding the same
 * downstream match both only ever want that match's lock *after* their own
 * distinct source match's lock, so this can't cycle into a deadlock.
 *
 * Returns whether the tournament reached `COMPLETE` as a direct or
 * *indirect* result of this call — the grand final's own decision, a reset
 * that turned out not to be needed, or a walkover several fills downstream
 * (a tournament-scope DQ can cascade through more than one match in a
 * single transaction) can each be the actual trigger, so this always
 * reflects the recursive cascade's outcome, never just this one match's.
 */
export async function persistAndCascade(
  tx: Tx,
  tournamentId: string,
  ref: MatchRef,
  matchId: string,
  format: MatchFormat,
  random: RandomPort,
  before: MatchState,
  after: MatchState,
): Promise<boolean> {
  const pending = format.pendingAction(after);
  const outcomeAfter = format.outcome(after);
  const outcomeBefore = format.outcome(before);

  await tx.match.update({
    where: { id: matchId },
    data: {
      state: after as unknown as Prisma.InputJsonValue,
      stateSeq: after.seq,
      status: outcomeAfter ? 'COMPLETE' : 'IN_PROGRESS',
      winnerId: outcomeAfter?.placements.find((p) => p.place === 1)?.entrantId ?? null,
      awaitingTo: pending.kind === 'AWAITING_TO',
      currentChartId: currentChartIdOf(after),
    },
  });

  if (!outcomeAfter) return false;

  // The `points`/`place` columns on `MatchParticipant` are this outcome,
  // written once as it commits — never recomputed live, same as `winnerId`.
  for (const p of outcomeAfter.placements) {
    await tx.matchParticipant.update({
      where: { matchId_entrantId: { matchId, entrantId: p.entrantId } },
      data: { points: p.points, place: p.place },
    });
  }

  if (outcomeBefore) return false; // already decided before this append — cascade already ran once.

  if (ref.bracket === 'GRAND_FINAL' && ref.round === 2) {
    await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'COMPLETE' } });
    return true;
  }

  const entrantCount = await entrantCountAtStart(tx, tournamentId);
  const bracket = generateBracket(entrantCount);

  if (ref.bracket === 'GRAND_FINAL' && ref.round === 1) {
    const participants = await tx.matchParticipant.findMany({ where: { matchId } });
    const winnerEntrantId = outcomeAfter.placements.find((p) => p.place === 1)!.entrantId;
    const winnerSlot = participants.find((p) => p.entrantId === winnerEntrantId)!.slot as 0 | 1;
    if (grandFinalNeedsReset(winnerSlot)) {
      const reset = await tx.match.findUniqueOrThrow({
        where: {
          tournamentId_bracket_round_slot: { tournamentId, bracket: 'GRAND_FINAL', round: 2, slot: ref.slot },
        },
      });
      // The reset can itself decide the tournament immediately — one of the
      // two finalists withdrawing between game 1 and the reset makes
      // `startSeatedMatch` walk it over on the spot — so its own completion
      // signal is what this reports, not an assumed `false`.
      return startSeatedMatch(tx, tournamentId, random, reset.id);
    }
    await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'COMPLETE' } });
    return true;
  }

  if (!bracket.grandFinalRef) {
    // Exactly two entrants: this single match decided the tournament outright.
    await tx.tournament.update({ where: { id: tournamentId }, data: { state: 'COMPLETE' } });
    return true;
  }

  const placements = outcomeAfter.placements
    .filter((p): p is (typeof outcomeAfter.placements)[number] & { place: 1 | 2 } => p.place === 1 || p.place === 2)
    .map((p) => ({ entrantId: p.entrantId, place: p.place }));
  const seeded = await tx.entrant.findMany({
    where: { id: { in: placements.map((p) => p.entrantId) } },
    select: { id: true, seed: true },
  });
  const seedOf = new Map(seeded.map((e) => [e.id, e.seed!]));
  const fills = routeCompletedMatch(
    bracket,
    ref,
    placements.map((p) => ({ seed: seedOf.get(p.entrantId)!, place: p.place })),
  );

  const touched = new Set<string>();
  for (const fill of fills) {
    const target = await tx.match.findUniqueOrThrow({
      where: {
        tournamentId_bracket_round_slot: {
          tournamentId,
          bracket: fill.match.bracket,
          round: fill.match.round,
          slot: fill.match.slot,
        },
      },
    });
    const entrant = await tx.entrant.findFirstOrThrow({ where: { tournamentId, seed: fill.seed } });
    await tx.matchParticipant.upsert({
      where: { matchId_slot: { matchId: target.id, slot: fill.slot } },
      update: {},
      create: { matchId: target.id, entrantId: entrant.id, slot: fill.slot },
    });
    touched.add(target.id);
  }

  let tournamentCompleted = false;
  for (const id of touched) {
    const completed = await maybeStartMatch(tx, tournamentId, random, id, bracket);
    tournamentCompleted ||= completed;
  }
  return tournamentCompleted;
}

/**
 * Appends `MATCH_CREATED` for a freshly two-seated match and either settles
 * it to the first person-facing `pendingAction` (the ordinary case) or, if
 * one of the two seated entrants has since withdrawn, immediately walks it
 * over to the other — the same check whether the match reached two seats
 * through ordinary advancement or through a tournament-scope DQ filling in
 * the second slot after the fact.
 */
async function startSeatedMatch(
  tx: Tx,
  tournamentId: string,
  random: RandomPort,
  matchId: string,
): Promise<boolean> {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  const format = requireFormat(match.formatKey);
  const ref: MatchRef = { bracket: match.bracket, round: match.round, slot: match.slot };
  const participants = await tx.matchParticipant.findMany({
    where: { matchId },
    include: { entrant: true },
  });

  const withdrawn = participants.filter((p) => p.entrant.status === 'WITHDRAWN');
  if (withdrawn.length === 2) {
    throw new Error(`match ${matchId}: both seated participants have withdrawn — needs a referee`);
  }

  const state0 = emptyState();
  const created = await appendOne(tx, matchId, state0, format, {
    actorId: null,
    type: 'MATCH_CREATED',
    payload: { participants: participants.map((p) => ({ entrantId: p.entrantId, seed: p.entrant.seed! })) },
  });

  if (withdrawn.length === 1) {
    const winner = participants.find((p) => p.entrantId !== withdrawn[0]!.entrantId)!;
    const walked = await appendOne(tx, matchId, created, format, {
      actorId: null,
      type: 'WALKOVER',
      payload: { winnerId: winner.entrantId },
    });
    return persistAndCascade(tx, tournamentId, ref, matchId, format, random, state0, walked);
  }

  const settled = await settleBotLoop(tx, tournamentId, random, matchId, created, format);
  return persistAndCascade(tx, tournamentId, ref, matchId, format, random, state0, settled);
}

/**
 * Called whenever a match's `MatchParticipant` count might have just
 * reached its structural maximum — after an advancement fill, or after
 * materializing round 1. That maximum is two for almost every match, but a
 * losers-bracket slot fed even in part by a winners-round-1 bye can have
 * only **one** ever-fillable source — `liveSourceCount` (bracket.ts) is
 * what tells the two apart. A round-1 bye is a different call entirely,
 * resolved at generation time — see `bracket-service.ts`.
 *
 * `bracket` is supplied by the caller — `persistAndCascade` and
 * `materializeBracket` each already compute it for their own purposes —
 * rather than recomputed here, since it is a pure function of
 * `entrantCount` alone and every caller already has it in hand.
 *
 * Idempotent by checking `status` fresh: `persistAndCascade`'s single
 * `touched` set can legitimately name the same match twice in one
 * cascade — once because it received a fill directly, again because a
 * *different* fill's own recursive cascade (a chain of one-live-source
 * walkovers, several deep) reached and started that same match first. A
 * match already past `PENDING` has already been started by one path or
 * the other; the second visit is a no-op rather than a second
 * `MATCH_CREATED`.
 */
export async function maybeStartMatch(
  tx: Tx,
  tournamentId: string,
  random: RandomPort,
  matchId: string,
  bracket: GeneratedBracket,
): Promise<boolean> {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  if (match.status !== 'PENDING') return false;
  // The reset waits on the grand final's own outcome, even once both
  // finalists are seeded into it ahead of time.
  if (match.bracket === 'GRAND_FINAL' && match.round === 2) return false;

  const ref: MatchRef = { bracket: match.bracket, round: match.round, slot: match.slot };
  const expected = liveSourceCount(bracket, ref);
  if (expected === 0) return false; // structurally unreachable — every source is a bye or downstream of one

  const participants = await tx.matchParticipant.findMany({ where: { matchId }, include: { entrant: true } });
  if (participants.length < expected) return false; // still waiting on a source that can still arrive

  if (expected === 2) return startSeatedMatch(tx, tournamentId, random, matchId);

  // One structurally live source: this slot's other occupant can never
  // arrive (a winners-round-1 bye, or a slot downstream of one), so the
  // lone occupant advances the moment they're seated — "byes need no
  // special case" (bracket-service.ts), one hop further into the graph.
  // Advances unconditionally, even if withdrawn: there is no "other real
  // participant" here to walk over *to*, so a withdrawn sole occupant
  // still becomes this match's `winnerId` and moves on exactly as
  // `startWithSeats` already does for a round-1 bye — but the moment they
  // next share a real, two-participant match, `startSeatedMatch`'s own
  // `withdrawn.length === 1` check (unchanged) walks straight over them.
  // The grand final always has two live sources (see the property test),
  // so that real check is always reached before it matters who takes the
  // tournament.
  const [sole] = participants;
  return startWithSeats(tx, tournamentId, random, matchId, [{ entrantId: sole!.entrantId, seed: sole!.entrant.seed! }], sole!.entrantId);
}

/** Exposed for `bracket-service.ts`'s bye resolution, which seats only one participant. */
export async function startWithSeats(
  tx: Tx,
  tournamentId: string,
  random: RandomPort,
  matchId: string,
  seatedParticipants: { entrantId: string; seed: number }[],
  walkoverWinnerId: string,
): Promise<boolean> {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  const format = requireFormat(match.formatKey);
  const ref: MatchRef = { bracket: match.bracket, round: match.round, slot: match.slot };
  const state0 = emptyState();
  const created = await appendOne(tx, matchId, state0, format, {
    actorId: null,
    type: 'MATCH_CREATED',
    payload: { participants: seatedParticipants },
  });
  const walked = await appendOne(tx, matchId, created, format, {
    actorId: null,
    type: 'WALKOVER',
    payload: { winnerId: walkoverWinnerId },
  });
  return persistAndCascade(tx, tournamentId, ref, matchId, format, random, state0, walked);
}
