import { afterAll, describe, expect, it } from 'vitest';
import {
  checkin,
  joinTournament,
  leaveTournament,
  rosterAdd,
  rosterCheckin,
  rosterRemove,
  rosterUncheckin,
} from '../src/services/roster-service.js';
import { closeCheckin, closeRegistration, createTournament, openCheckin, openRegistration } from '../src/services/tournament-service.js';
import { isReachable, prisma } from './support.js';

/**
 * `/join`, `/checkin`, `/leave`, and `/roster`'s on-behalf equivalents,
 * against real Postgres — DESIGN.md's "Registration and Check-in" command
 * table and "Acting on a player's behalf". Skipped when no database is
 * reachable.
 */
describe.skipIf(!(await isReachable()))('roster-service', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const TO = 'to-user';

  async function makeGuild(id: string): Promise<void> {
    await prisma.guild.create({
      data: {
        id,
        matchesChannelId: 'matches-chan',
        alertChannelId: 'alerts-chan',
        resultsChannelId: 'results-chan',
        refereeRoleId: 'referee-role',
        toRoleId: 'to-role',
      },
    });
  }

  async function dropGuild(id: string): Promise<void> {
    await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  }

  /** Drives a fresh tournament to `REGISTRATION_OPEN` and returns its id. */
  async function toRegistrationOpen(guildId: string): Promise<string> {
    await makeGuild(guildId);
    const t = await createTournament(prisma, guildId, 'T', TO);
    await openRegistration(prisma, t.id, TO);
    return t.id;
  }

  /** Drives a fresh tournament to `CHECKIN_OPEN` and returns its id. */
  async function toCheckinOpen(guildId: string): Promise<string> {
    const tournamentId = await toRegistrationOpen(guildId);
    await closeRegistration(prisma, tournamentId, TO);
    await openCheckin(prisma, tournamentId, TO);
    return tournamentId;
  }

  async function entrantOf(tournamentId: string, discordUserId: string) {
    return prisma.entrant.findUniqueOrThrow({ where: { tournamentId_discordUserId: { tournamentId, discordUserId } } });
  }

  describe('joinTournament', () => {
    it('rejects when the guild has no active tournament', async () => {
      const guildId = `rs-join-none-${Date.now()}`;
      await makeGuild(guildId);
      try {
        const result = await joinTournament(prisma, guildId, 'p1');
        expect(result.kind).toBe('NO_TOURNAMENT');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects as NO_TOURNAMENT, not naming the phase, while the tournament is still a draft', async () => {
      const guildId = `rs-join-draft-${Date.now()}`;
      await makeGuild(guildId);
      try {
        await createTournament(prisma, guildId, 'T', TO);
        const result = await joinTournament(prisma, guildId, 'p1');
        expect(result).toEqual({ kind: 'NO_TOURNAMENT' });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects, naming the phase, once registration has closed', async () => {
      const guildId = `rs-join-closed-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        const result = await joinTournament(prisma, guildId, 'p1');
        expect(result).toEqual({ kind: 'WINDOW_CLOSED', phase: 'CHECKIN_OPEN' });
        void tournamentId;
      } finally {
        await dropGuild(guildId);
      }
    });

    it('joins while registration is open, and confirms (not an error) on a repeat join', async () => {
      const guildId = `rs-join-ok-${Date.now()}`;
      try {
        const tournamentId = await toRegistrationOpen(guildId);
        const first = await joinTournament(prisma, guildId, 'p1');
        expect(first.kind).toBe('JOINED');
        if (first.kind !== 'JOINED') throw new Error('unreachable');
        expect(first.entrant.status).toBe('ACTIVE');
        expect(first.entrant.checkedIn).toBe(false);

        const second = await joinTournament(prisma, guildId, 'p1');
        expect(second.kind).toBe('ALREADY_JOINED');

        const rows = await prisma.entrant.findMany({ where: { tournamentId } });
        expect(rows).toHaveLength(1); // no duplicate row from the repeat join
      } finally {
        await dropGuild(guildId);
      }
    });

    it('re-joining after withdrawing reactivates the same entrant row', async () => {
      const guildId = `rs-join-rejoin-${Date.now()}`;
      try {
        const tournamentId = await toRegistrationOpen(guildId);
        const joined = await joinTournament(prisma, guildId, 'p1');
        if (joined.kind !== 'JOINED') throw new Error('unreachable');
        const entrantId = joined.entrant.id;

        const left = await leaveTournament(prisma, guildId, 'p1');
        expect(left.kind).toBe('LEFT');

        const rejoined = await joinTournament(prisma, guildId, 'p1');
        expect(rejoined.kind).toBe('JOINED');
        if (rejoined.kind !== 'JOINED') throw new Error('unreachable');
        expect(rejoined.entrant.id).toBe(entrantId); // same row, not a new one
        expect(rejoined.entrant.status).toBe('ACTIVE');

        const rows = await prisma.entrant.findMany({ where: { tournamentId } });
        expect(rows).toHaveLength(1);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('checkin', () => {
    it('rejects as NO_TOURNAMENT, not naming the phase, while the tournament is still a draft', async () => {
      const guildId = `rs-checkin-draft-${Date.now()}`;
      await makeGuild(guildId);
      try {
        await createTournament(prisma, guildId, 'T', TO);
        const result = await checkin(prisma, guildId, 'p1');
        expect(result).toEqual({ kind: 'NO_TOURNAMENT' });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects, naming the phase, before check-in opens', async () => {
      const guildId = `rs-checkin-early-${Date.now()}`;
      try {
        await toRegistrationOpen(guildId);
        const result = await checkin(prisma, guildId, 'p1');
        expect(result).toEqual({ kind: 'WINDOW_CLOSED', phase: 'REGISTRATION_OPEN' });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects someone who never registered', async () => {
      const guildId = `rs-checkin-unregistered-${Date.now()}`;
      try {
        await toCheckinOpen(guildId);
        const result = await checkin(prisma, guildId, 'ghost');
        expect(result.kind).toBe('NOT_REGISTERED');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('checks in, and confirms (not an error) on a repeat check-in', async () => {
      const guildId = `rs-checkin-ok-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'p1' } });

        const first = await checkin(prisma, guildId, 'p1');
        expect(first.kind).toBe('CHECKED_IN');
        const second = await checkin(prisma, guildId, 'p1');
        expect(second.kind).toBe('ALREADY_CHECKED_IN');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects someone who withdrew — a status check, not just a row check', async () => {
      const guildId = `rs-checkin-withdrawn-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'p1', status: 'WITHDRAWN' } });
        const result = await checkin(prisma, guildId, 'p1');
        expect(result.kind).toBe('NOT_REGISTERED');
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('leaveTournament', () => {
    it('rejects as NO_TOURNAMENT while the tournament is still a draft', async () => {
      const guildId = `rs-leave-draft-${Date.now()}`;
      await makeGuild(guildId);
      try {
        await createTournament(prisma, guildId, 'T', TO);
        const result = await leaveTournament(prisma, guildId, 'p1');
        expect(result).toEqual({ kind: 'NO_TOURNAMENT' });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects once the tournament is running', async () => {
      const guildId = `rs-leave-running-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        await prisma.tournament.update({ where: { id: tournamentId }, data: { state: 'RUNNING' } });
        const result = await leaveTournament(prisma, guildId, 'p1');
        expect(result.kind).toBe('TOURNAMENT_RUNNING');
      } finally {
        await dropGuild(guildId);
      }
    });

    it('is silent (no alert) and clears the seed when leaving before check-in closes', async () => {
      const guildId = `rs-leave-early-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        // A seed can already exist here in principle (manual TO seeding is a
        // later phase, but the field itself allows it) — leaving before
        // check-in closes must still clear it, since "seed gaps do not
        // matter yet" only holds if it actually gets cleared.
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'p1', seed: 5 } });

        const result = await leaveTournament(prisma, guildId, 'p1');
        expect(result).toMatchObject({ kind: 'LEFT', alertNeeded: false });

        const row = await entrantOf(tournamentId, 'p1');
        expect(row.status).toBe('WITHDRAWN');
        expect(row.seed).toBeNull();
      } finally {
        await dropGuild(guildId);
      }
    });

    it('needs an alert and re-normalizes the field when leaving after check-in closes', async () => {
      const guildId = `rs-leave-late-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        for (const [name, seed] of [['p1', 1], ['p2', 2], ['p3', 3], ['p4', 4]] as const) {
          await prisma.entrant.create({ data: { tournamentId, discordUserId: name, seed, checkedIn: true } });
        }
        await closeCheckin(prisma, tournamentId, TO);

        const result = await leaveTournament(prisma, guildId, 'p2');
        expect(result).toMatchObject({ kind: 'LEFT', alertNeeded: true });

        const [p1, p2, p3, p4] = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((u) => entrantOf(tournamentId, u)));
        expect(p1!.seed).toBe(1);
        expect(p2!.status).toBe('WITHDRAWN');
        expect(p2!.seed).toBeNull();
        expect(p3!.seed).toBe(2); // renumbered down
        expect(p4!.seed).toBe(3); // renumbered down
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('rosterAdd', () => {
    it('adds an entrant after registration has closed — a superset of /join\'s own window', async () => {
      const guildId = `rs-add-late-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        const result = await rosterAdd(prisma, guildId, 'p1', TO);
        expect(result.kind).toBe('JOINED');
        const row = await entrantOf(tournamentId, 'p1');
        expect(row.status).toBe('ACTIVE');
        expect(row.checkedIn).toBe(false);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses once the tournament is running', async () => {
      const guildId = `rs-add-running-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        await prisma.tournament.update({ where: { id: tournamentId }, data: { state: 'RUNNING' } });
        const result = await rosterAdd(prisma, guildId, 'p1', TO);
        expect(result).toEqual({ kind: 'TOO_LATE', phase: 'RUNNING' });
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('rosterCheckin', () => {
    it('checks someone in after check-in has closed, re-running normalization to append them', async () => {
      const guildId = `rs-rc-late-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        for (const [name, seed] of [['p1', 1], ['p2', 2], ['p3', 3]] as const) {
          await prisma.entrant.create({ data: { tournamentId, discordUserId: name, seed, checkedIn: true } });
        }
        // Registered but never checked in — closeCheckin drops their seed.
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'late', checkedIn: false } });
        await closeCheckin(prisma, tournamentId, TO);

        const result = await rosterCheckin(prisma, guildId, 'late', TO);
        expect(result.kind).toBe('CHECKED_IN');

        const late = await entrantOf(tournamentId, 'late');
        expect(late.checkedIn).toBe(true);
        expect(late.seed).toBe(4); // appended after the three survivors

        const p1 = await entrantOf(tournamentId, 'p1');
        expect(p1.seed).toBe(1); // untouched
      } finally {
        await dropGuild(guildId);
      }
    });

    it('reactivates a withdrawn entrant', async () => {
      const guildId = `rs-rc-reactivate-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'p1', status: 'WITHDRAWN' } });

        const result = await rosterCheckin(prisma, guildId, 'p1', TO);
        expect(result.kind).toBe('CHECKED_IN');

        const row = await entrantOf(tournamentId, 'p1');
        expect(row.status).toBe('ACTIVE');
        expect(row.checkedIn).toBe(true);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('rejects before check-in has ever opened', async () => {
      const guildId = `rs-rc-early-${Date.now()}`;
      try {
        const tournamentId = await toRegistrationOpen(guildId);
        await prisma.entrant.create({ data: { tournamentId, discordUserId: 'p1' } });
        const result = await rosterCheckin(prisma, guildId, 'p1', TO);
        expect(result).toEqual({ kind: 'WINDOW_CLOSED', phase: 'REGISTRATION_OPEN' });
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('rosterUncheckin', () => {
    it('un-checks someone in after check-in closes and re-normalizes the field', async () => {
      const guildId = `rs-ru-late-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        for (const [name, seed] of [['p1', 1], ['p2', 2], ['p3', 3]] as const) {
          await prisma.entrant.create({ data: { tournamentId, discordUserId: name, seed, checkedIn: true } });
        }
        await closeCheckin(prisma, tournamentId, TO);

        const result = await rosterUncheckin(prisma, guildId, 'p2', TO);
        expect(result.kind).toBe('UNCHECKED_IN');

        const [p1, p2, p3] = await Promise.all(['p1', 'p2', 'p3'].map((u) => entrantOf(tournamentId, u)));
        expect(p1!.seed).toBe(1);
        expect(p2!.checkedIn).toBe(false);
        expect(p2!.status).toBe('ACTIVE'); // un-checkin, unlike remove, keeps them on the roster
        expect(p2!.seed).toBeNull();
        expect(p3!.seed).toBe(2); // renumbered down
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('rosterRemove', () => {
    it('withdraws on the player\'s behalf and never raises an alert, unlike a late self-service /leave', async () => {
      const guildId = `rs-rr-late-${Date.now()}`;
      try {
        const tournamentId = await toCheckinOpen(guildId);
        for (const [name, seed] of [['p1', 1], ['p2', 2]] as const) {
          await prisma.entrant.create({ data: { tournamentId, discordUserId: name, seed, checkedIn: true } });
        }
        await closeCheckin(prisma, tournamentId, TO);

        const result = await rosterRemove(prisma, guildId, 'p1', TO);
        expect(result.kind).toBe('REMOVED');
        expect(result).not.toHaveProperty('alertNeeded');

        const p2 = await entrantOf(tournamentId, 'p2');
        expect(p2.seed).toBe(1); // renormalized despite no alert
      } finally {
        await dropGuild(guildId);
      }
    });
  });
});
