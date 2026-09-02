import { afterAll, describe, expect, it } from 'vitest';
import { FORMAT_SONG_LABELS } from '@itg/shared';
import {
  createSongPoolTab,
  deleteSongPoolTab,
  listSongPoolTabs,
  saveSongPoolLabels,
  SongPoolTabError,
  validateSongPool,
} from '../src/services/song-pool-service.js';
import { isReachable, prisma } from './support.js';

/**
 * `createSongPoolTab`/`deleteSongPoolTab`/`saveSongPoolLabels`/
 * `validateSongPool` against real Postgres — the web pack view's per-format
 * tabs (NEW_FORMAT.md's "Song Pool"). Skipped when no database is
 * reachable.
 */
describe.skipIf(!(await isReachable()))('song-pool-service', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const ACTOR = 'to-user';
  const HB11 = 'hb11-static-pool';
  const HB11_LABELS = FORMAT_SONG_LABELS[HB11]!;

  /** A guild + tournament + `chartCount` unlabeled charts. No entrants, no lifecycle progression — song-pool functions don't care about either. */
  async function makeTournamentWithCharts(guildId: string, chartCount: number): Promise<{ tournamentId: string; chartIds: string[] }> {
    await prisma.guild.create({ data: { id: guildId } });
    const tournament = await prisma.tournament.create({
      data: { guildId, name: `test-${guildId}`, defaultFormatKey: HB11, config: {} },
    });
    const chartIds: string[] = [];
    for (let i = 0; i < chartCount; i++) {
      const c = await prisma.chart.create({
        data: { tournamentId: tournament.id, title: `Song ${i}`, playStyle: 'SINGLE', difficulty: 'EXPERT', meter: 12 },
      });
      chartIds.push(c.id);
    }
    return { tournamentId: tournament.id, chartIds };
  }

  async function dropGuild(id: string): Promise<void> {
    await prisma.guild.delete({ where: { id } }).catch(() => undefined);
  }

  describe('createSongPoolTab', () => {
    it('creates a tab for a static-pool format', async () => {
      const guildId = `sp-create-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        const tabs = await listSongPoolTabs(prisma, tournamentId);
        expect(tabs).toEqual([{ formatKey: HB11, assignments: {} }]);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses a format with no static song pool', async () => {
      const guildId = `sp-create-nonstatic-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      try {
        await expect(createSongPoolTab(prisma, tournamentId, 'bo5-protect-veto', ACTOR)).rejects.toThrow(SongPoolTabError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses a second tab for the same format', async () => {
      const guildId = `sp-create-dup-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        await expect(createSongPoolTab(prisma, tournamentId, HB11, ACTOR)).rejects.toThrow(SongPoolTabError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('saveSongPoolLabels and validateSongPool', () => {
    it('persists a partial save and reports exactly which labels are missing', async () => {
      const guildId = `sp-partial-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 11);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        // Label only the first 3 of 11 required.
        const assignments = Object.fromEntries(chartIds.slice(0, 3).map((id, i) => [id, HB11_LABELS[i]!]));
        const issues = await saveSongPoolLabels(prisma, tournamentId, HB11, assignments, ACTOR);
        expect(issues).not.toBeNull();
        expect(issues!.missingLabels.sort()).toEqual(HB11_LABELS.slice(3).sort());
        expect(issues!.duplicateLabels).toEqual({});

        const tabs = await listSongPoolTabs(prisma, tournamentId);
        expect(tabs[0]!.assignments).toEqual(assignments);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('reports a label assigned to more than one chart, without dropping either assignment', async () => {
      const guildId = `sp-duplicate-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 2);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        const assignments = { [chartIds[0]!]: 'RD1', [chartIds[1]!]: 'RD1' };
        const issues = await saveSongPoolLabels(prisma, tournamentId, HB11, assignments, ACTOR);
        expect(issues).not.toBeNull();
        expect(issues!.duplicateLabels['RD1']?.sort()).toEqual([...chartIds].sort());

        const tabs = await listSongPoolTabs(prisma, tournamentId);
        expect(tabs[0]!.assignments).toEqual(assignments);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('returns null once every required label is used exactly once', async () => {
      const guildId = `sp-complete-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 11);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        const assignments = Object.fromEntries(chartIds.map((id, i) => [id, HB11_LABELS[i]!]));
        const issues = await saveSongPoolLabels(prisma, tournamentId, HB11, assignments, ACTOR);
        expect(issues).toBeNull();

        const revalidated = await prisma.$transaction((tx) => validateSongPool(tx, tournamentId, HB11));
        expect(revalidated).toBeNull();
      } finally {
        await dropGuild(guildId);
      }
    });

    it('a later save fully replaces the previous set, not merges into it', async () => {
      const guildId = `sp-replace-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 2);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        await saveSongPoolLabels(prisma, tournamentId, HB11, { [chartIds[0]!]: 'RD1' }, ACTOR);
        await saveSongPoolLabels(prisma, tournamentId, HB11, { [chartIds[1]!]: 'RD2' }, ACTOR);

        const tabs = await listSongPoolTabs(prisma, tournamentId);
        expect(tabs[0]!.assignments).toEqual({ [chartIds[1]!]: 'RD2' });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses a chart id from outside the tournament', async () => {
      const guildId = `sp-foreign-${Date.now()}`;
      const other = `sp-foreign-other-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      const { chartIds: otherChartIds } = await makeTournamentWithCharts(other, 1);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        await expect(
          saveSongPoolLabels(prisma, tournamentId, HB11, { [otherChartIds[0]!]: 'RD1' }, ACTOR),
        ).rejects.toThrow(SongPoolTabError);
      } finally {
        await dropGuild(guildId);
        await dropGuild(other);
      }
    });

    it('refuses to save labels for a format with no tab yet', async () => {
      const guildId = `sp-no-tab-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 1);
      try {
        await expect(
          saveSongPoolLabels(prisma, tournamentId, HB11, { [chartIds[0]!]: 'RD1' }, ACTOR),
        ).rejects.toThrow(SongPoolTabError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('validateSongPool returns null outright for a format with no static pool', async () => {
      const guildId = `sp-validate-nonstatic-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      try {
        const issues = await prisma.$transaction((tx) => validateSongPool(tx, tournamentId, 'bo5-protect-veto'));
        expect(issues).toBeNull();
      } finally {
        await dropGuild(guildId);
      }
    });
  });

  describe('deleteSongPoolTab', () => {
    it('removes the tab and every label it carried', async () => {
      const guildId = `sp-delete-${Date.now()}`;
      const { tournamentId, chartIds } = await makeTournamentWithCharts(guildId, 1);
      try {
        await createSongPoolTab(prisma, tournamentId, HB11, ACTOR);
        await saveSongPoolLabels(prisma, tournamentId, HB11, { [chartIds[0]!]: 'RD1' }, ACTOR);

        await deleteSongPoolTab(prisma, tournamentId, HB11, ACTOR);

        expect(await listSongPoolTabs(prisma, tournamentId)).toEqual([]);
        expect(await prisma.chartLabel.count({ where: { tournamentId, formatKey: HB11 } })).toBe(0);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses to delete a tab that does not exist', async () => {
      const guildId = `sp-delete-missing-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 0);
      try {
        await expect(deleteSongPoolTab(prisma, tournamentId, HB11, ACTOR)).rejects.toThrow(SongPoolTabError);
      } finally {
        await dropGuild(guildId);
      }
    });
  });
});
