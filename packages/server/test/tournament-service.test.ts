import { afterAll, describe, expect, it } from 'vitest';
import {
  cancelTournament,
  closeCheckin,
  closeRegistration,
  createTournament,
  openCheckin,
  openRegistration,
  renameTournament,
  startTournament,
  TournamentSlotOccupiedError,
  TournamentTransitionError,
} from '../src/services/tournament-service.js';
import { sequentialRandomPort } from '../src/services/ports.js';
import { isReachable, prisma } from './support.js';

/**
 * Drives the tournament lifecycle state machine against real Postgres —
 * DESIGN.md's "Tournament Lifecycle" table, end to end. Guild/entrant setup
 * is done directly via Prisma rather than through `support.ts`'s
 * `makeTournament` (which seeds a tournament straight into `RUNNING`, the
 * end state these tests are building up to) since every lifecycle state
 * along the way needs to be reachable and inspectable. Skipped when no
 * database is reachable.
 */
describe.skipIf(!(await isReachable()))('tournament-service', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const ACTOR = 'to-user';

  async function makeGuild(id: string, configured: boolean): Promise<void> {
    await prisma.guild.create({
      data: configured
        ? {
            id,
            matchesChannelId: 'matches-chan',
            alertChannelId: 'alerts-chan',
            resultsChannelId: 'results-chan',
            refereeRoleId: 'referee-role',
            toRoleId: 'to-role',
          }
        : { id },
    });
  }

  async function dropGuild(id: string): Promise<void> {
    await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  }

  async function addEntrant(
    tournamentId: string,
    discordUserId: string,
    opts: { seed?: number; checkedIn?: boolean } = {},
  ): Promise<string> {
    const e = await prisma.entrant.create({
      data: { tournamentId, discordUserId, seed: opts.seed ?? null, checkedIn: opts.checkedIn ?? false },
    });
    return e.id;
  }

  describe('createTournament', () => {
    const guildId = `ts-create-${Date.now()}`;

    it('starts in DRAFT, stamped with the one shipped format', async () => {
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'Winter Cup', ACTOR);
        expect(t.state).toBe('DRAFT');
        expect(t.defaultFormatKey).toBe('bo5-protect-veto');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('occupies the guild\'s slot immediately — a second create is refused, naming the held tournament', async () => {
      await makeGuild(guildId, true);
      try {
        await createTournament(prisma, guildId, 'First Draft', ACTOR);
        await expect(createTournament(prisma, guildId, 'Second Draft', ACTOR)).rejects.toMatchObject({
          held: { name: 'First Draft', state: 'DRAFT' },
        });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('is reachable again once the held tournament is cancelled or completes', async () => {
      const cancelGuildId = `ts-create-after-cancel-${Date.now()}`;
      await makeGuild(cancelGuildId, true);
      try {
        const first = await createTournament(prisma, cancelGuildId, 'First', ACTOR);
        await cancelTournament(prisma, first.id, ACTOR);
        const second = await createTournament(prisma, cancelGuildId, 'Second', ACTOR);
        expect(second.state).toBe('DRAFT');
      } finally {
        await dropGuild(cancelGuildId);
      }
    });
  });

  describe('openRegistration', () => {
    it('refuses when the guild is not fully configured', async () => {
      const guildId = `ts-unconfigured-${Date.now()}`;
      await makeGuild(guildId, false);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await expect(openRegistration(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('opens registration when the guild is configured', async () => {
      const guildId = `ts-open-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        const opened = await openRegistration(prisma, t.id, ACTOR);
        expect(opened.state).toBe('REGISTRATION_OPEN');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses once already open — REGISTRATION_OPEN is not a valid starting state', async () => {
      const guildId = `ts-wrongstate-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await expect(openRegistration(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('reopens from REGISTRATION_CLOSED — a TO who closed it too early can undo that', async () => {
      const guildId = `ts-reg-reopen-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        const reopened = await openRegistration(prisma, t.id, ACTOR);
        expect(reopened.state).toBe('REGISTRATION_OPEN');
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('closeRegistration', () => {
    it('closes from CHECKIN_OPEN too — undoing an open-checkin that ran too early', async () => {
      const guildId = `ts-closereg-undo-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);

        const closed = await closeRegistration(prisma, t.id, ACTOR);
        expect(closed.state).toBe('REGISTRATION_CLOSED');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses from DRAFT or REGISTRATION_CLOSED', async () => {
      const guildId = `ts-closereg-wrongstate-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await expect(closeRegistration(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('cancelTournament', () => {
    it('is reachable from DRAFT and frees the guild\'s active slot for the next one', async () => {
      const guildId = `ts-cancel-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const first = await createTournament(prisma, guildId, 'To Cancel', ACTOR);
        await openRegistration(prisma, first.id, ACTOR);
        const cancelled = await cancelTournament(prisma, first.id, ACTOR);
        expect(cancelled.state).toBe('CANCELLED');

        const second = await createTournament(prisma, guildId, 'Replacement', ACTOR);
        const opened = await openRegistration(prisma, second.id, ACTOR);
        expect(opened.state).toBe('REGISTRATION_OPEN');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses once the tournament is RUNNING', async () => {
      const guildId = `ts-cancel-running-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);
        await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
        await addEntrant(t.id, 'p2', { seed: 2, checkedIn: true });
        await closeCheckin(prisma, t.id, ACTOR);
        for (let i = 0; i < 12; i++) {
          await prisma.chart.create({
            data: { tournamentId: t.id, title: `Song ${i}`, playStyle: 'SINGLE', difficulty: 'EXPERT', meter: 12 },
          });
        }
        await startTournament(prisma, sequentialRandomPort(guildId), t.id, new Map(), ACTOR);

        await expect(cancelTournament(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('renameTournament', () => {
    it('renames a tournament regardless of which pre-terminal state it is in', async () => {
      const guildId = `ts-rename-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'Original Name', ACTOR);
        const renamed = await renameTournament(prisma, t.id, 'New Name', ACTOR);
        expect(renamed.name).toBe('New Name');
        expect(renamed.state).toBe('DRAFT'); // renaming doesn't move the state machine

        await openRegistration(prisma, t.id, ACTOR);
        const renamedAgain = await renameTournament(prisma, t.id, 'Newer Name', ACTOR);
        expect(renamedAgain.name).toBe('Newer Name');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses once the tournament is cancelled or complete', async () => {
      const guildId = `ts-rename-terminal-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await cancelTournament(prisma, t.id, ACTOR);
        await expect(renameTournament(prisma, t.id, 'Too Late', ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('openCheckin', () => {
    it('reopens from CHECKIN_CLOSED, and a fresh close-checkin folds in whoever checked in during the reopened window', async () => {
      const guildId = `ts-checkin-reopen-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);

        const e1 = await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
        const e2 = await addEntrant(t.id, 'p2', { seed: 2, checkedIn: true });
        const e3 = await addEntrant(t.id, 'p3', { seed: 3, checkedIn: false }); // no-show, first time around

        const closed = await closeCheckin(prisma, t.id, ACTOR);
        expect(closed.state).toBe('CHECKIN_CLOSED');
        expect((await prisma.entrant.findUniqueOrThrow({ where: { id: e3 } })).seed).toBeNull();

        // Reopened — e.g. check-in was closed too early.
        const reopened = await openCheckin(prisma, t.id, ACTOR);
        expect(reopened.state).toBe('CHECKIN_OPEN');

        // p3 checks in during the reopened window.
        await prisma.entrant.update({ where: { id: e3 }, data: { checkedIn: true } });

        const closedAgain = await closeCheckin(prisma, t.id, ACTOR);
        expect(closedAgain.state).toBe('CHECKIN_CLOSED');

        const [r1, r2, r3] = await Promise.all([e1, e2, e3].map((id) => prisma.entrant.findUniqueOrThrow({ where: { id } })));
        expect(r1!.seed).toBe(1);
        expect(r2!.seed).toBe(2);
        expect(r3!.seed).toBe(3); // appended after the still-seeded survivors
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses from states other than REGISTRATION_CLOSED or CHECKIN_CLOSED', async () => {
      const guildId = `ts-checkin-open-wrongstate-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await expect(openCheckin(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('closeCheckin', () => {
    it('drops no-shows, renumbers survivors from 1 preserving order, and appends unseeded check-ins in join order', async () => {
      const guildId = `ts-checkin-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);

        // Seeded 1..4; seed 3 never checks in.
        const e1 = await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
        const e2 = await addEntrant(t.id, 'p2', { seed: 2, checkedIn: true });
        const e3 = await addEntrant(t.id, 'p3', { seed: 3, checkedIn: false });
        const e4 = await addEntrant(t.id, 'p4', { seed: 4, checkedIn: true });
        // Checked in but never seeded — should land after the seeded
        // survivors, ordered by when they joined.
        const e5 = await addEntrant(t.id, 'p5', { checkedIn: true });

        const closed = await closeCheckin(prisma, t.id, ACTOR);
        expect(closed.state).toBe('CHECKIN_CLOSED');

        const [r1, r2, r3, r4, r5] = await Promise.all(
          [e1, e2, e3, e4, e5].map((id) => prisma.entrant.findUniqueOrThrow({ where: { id } })),
        );
        expect(r1!.seed).toBe(1);
        expect(r2!.seed).toBe(2);
        expect(r3!.seed).toBeNull(); // dropped — never checked in
        expect(r3!.checkedIn).toBe(false); // status is not touched, per DESIGN.md
        expect(r4!.seed).toBe(3); // renumbered down, relative order preserved
        expect(r5!.seed).toBe(4); // unseeded check-in appended last
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses from any state but CHECKIN_OPEN', async () => {
      const guildId = `ts-checkin-wrongstate-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await expect(closeCheckin(prisma, t.id, ACTOR)).rejects.toThrow(TournamentTransitionError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('startTournament', () => {
    async function readyToStart(guildId: string, packSize: number): Promise<string> {
      await makeGuild(guildId, true);
      const t = await createTournament(prisma, guildId, 'T', ACTOR);
      await openRegistration(prisma, t.id, ACTOR);
      await closeRegistration(prisma, t.id, ACTOR);
      await openCheckin(prisma, t.id, ACTOR);
      await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
      await addEntrant(t.id, 'p2', { seed: 2, checkedIn: true });
      await closeCheckin(prisma, t.id, ACTOR);
      for (let i = 0; i < packSize; i++) {
        await prisma.chart.create({
          data: { tournamentId: t.id, title: `Song ${i}`, playStyle: 'SINGLE', difficulty: 'EXPERT', meter: 12 },
        });
      }
      return t.id;
    }

    it('transitions to RUNNING, snapshots display names, and materializes the bracket', async () => {
      const guildId = `ts-start-${Date.now()}`;
      try {
        const tournamentId = await readyToStart(guildId, 12);
        const entrants = await prisma.entrant.findMany({ where: { tournamentId } });
        const names = new Map(entrants.map((e) => [e.id, `Snapshot(${e.discordUserId})`]));

        const result = await startTournament(prisma, sequentialRandomPort(guildId), tournamentId, names, ACTOR);
        expect(result.tournament.state).toBe('RUNNING');
        expect(result.packSizeWarning).toBeNull();

        const updated = await prisma.entrant.findMany({ where: { tournamentId } });
        for (const e of updated) {
          expect(e.displayName).toBe(`Snapshot(${e.discordUserId})`);
        }

        const matches = await prisma.match.findMany({ where: { tournamentId } });
        expect(matches.length).toBeGreaterThan(0);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('warns, without blocking, when the pack is below the format\'s recommended size', async () => {
      const guildId = `ts-start-packwarn-${Date.now()}`;
      try {
        const tournamentId = await readyToStart(guildId, 3); // Bo5's recommendedPackSize is 10
        const result = await startTournament(prisma, sequentialRandomPort(guildId), tournamentId, new Map(), ACTOR);
        expect(result.tournament.state).toBe('RUNNING');
        expect(result.packSizeWarning).toEqual({ recommended: 10, actual: 3 });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses with 0 checked-in entrants and leaves the tournament in CHECKIN_CLOSED, not stuck in RUNNING', async () => {
      // Regression: this exact case reached `materializeBracket` live against
      // a real guild before this guard existed, crashed on
      // `generateBracket(0)`, and left the tournament stuck in RUNNING with
      // no bracket and no way back through the state machine.
      const guildId = `ts-start-noentrants-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);
        await closeCheckin(prisma, t.id, ACTOR);

        await expect(startTournament(prisma, sequentialRandomPort(guildId), t.id, new Map(), ACTOR)).rejects.toThrow(
          TournamentTransitionError,
        );

        const after = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.state).toBe('CHECKIN_CLOSED');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses with an empty chart pack and leaves the tournament in CHECKIN_CLOSED', async () => {
      const guildId = `ts-start-emptypack-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);
        await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
        await addEntrant(t.id, 'p2', { seed: 2, checkedIn: true });
        await closeCheckin(prisma, t.id, ACTOR);
        // No charts created — the pack is empty.

        await expect(startTournament(prisma, sequentialRandomPort(guildId), t.id, new Map(), ACTOR)).rejects.toThrow(
          TournamentTransitionError,
        );

        const after = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.state).toBe('CHECKIN_CLOSED');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses from any state but CHECKIN_CLOSED', async () => {
      const guildId = `ts-start-wrongstate-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await expect(startTournament(prisma, sequentialRandomPort(guildId), t.id, new Map(), ACTOR)).rejects.toThrow(
          TournamentTransitionError,
        );
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses as an assertion when active entrants are not seeded 1..N contiguously', async () => {
      const guildId = `ts-start-badseed-${Date.now()}`;
      await makeGuild(guildId, true);
      try {
        const t = await createTournament(prisma, guildId, 'T', ACTOR);
        await openRegistration(prisma, t.id, ACTOR);
        await closeRegistration(prisma, t.id, ACTOR);
        await openCheckin(prisma, t.id, ACTOR);
        // Bypasses closeCheckin's normalization to construct the broken
        // invariant directly — this should never happen via the ordinary
        // lifecycle, which is exactly why it's an assertion, not a gate.
        await addEntrant(t.id, 'p1', { seed: 1, checkedIn: true });
        await addEntrant(t.id, 'p2', { seed: 3, checkedIn: true });
        await prisma.tournament.update({ where: { id: t.id }, data: { state: 'CHECKIN_CLOSED' } });

        await expect(startTournament(prisma, sequentialRandomPort(guildId), t.id, new Map(), ACTOR)).rejects.toThrow(
          TournamentTransitionError,
        );
      } finally {
        await dropGuild(guildId);
      }
    });
  });
});
