import type { TournamentState } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { FORMAT_SONG_LABELS } from '@itg/shared';
import {
  createSongPoolTab,
  deleteSongPoolTab,
  importFromPreviousTournament,
  listImportCandidates,
  listSongPoolTabs,
  PreviousEventImportError,
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
  async function makeTournamentWithCharts(
    guildId: string,
    chartCount: number,
    opts: { state?: TournamentState; name?: string } = {},
  ): Promise<{ tournamentId: string; chartIds: string[] }> {
    await prisma.guild.upsert({ where: { id: guildId }, create: { id: guildId }, update: {} });
    const tournament = await prisma.tournament.create({
      data: { guildId, name: opts.name ?? `test-${guildId}`, defaultFormatKey: HB11, config: {}, state: opts.state ?? 'DRAFT' },
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

  /** Labels must be saved while a tournament is still editable — this flips it to COMPLETE afterward, the same order a real event follows. */
  async function markComplete(tournamentId: string): Promise<void> {
    await prisma.tournament.update({ where: { id: tournamentId }, data: { state: 'COMPLETE' } });
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

  describe('listImportCandidates', () => {
    it('lists finished tournaments in the guild, newest first, each with its chart count', async () => {
      const guildId = `sp-candidates-${Date.now()}`;
      const { tournamentId: older } = await makeTournamentWithCharts(guildId, 2, { state: 'COMPLETE', name: 'Older Cup' });
      await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for a stable newest-first order
      const { tournamentId: newer } = await makeTournamentWithCharts(guildId, 0, { state: 'CANCELLED', name: 'Newer Cup' });
      const { tournamentId: target } = await makeTournamentWithCharts(guildId, 0);
      try {
        const candidates = await listImportCandidates(prisma, guildId, target);
        expect(candidates.map((c) => c.id)).toEqual([newer, older]);
        expect(candidates.find((c) => c.id === older)?.chartCount).toBe(2);
        expect(candidates.find((c) => c.id === newer)?.chartCount).toBe(0);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('excludes the target tournament itself, even if it were somehow finished', async () => {
      const guildId = `sp-candidates-self-${Date.now()}`;
      const { tournamentId: target } = await makeTournamentWithCharts(guildId, 1, { state: 'COMPLETE' });
      try {
        expect(await listImportCandidates(prisma, guildId, target)).toEqual([]);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('never lists a tournament from a different guild', async () => {
      const guildId = `sp-candidates-guild-${Date.now()}`;
      const otherGuildId = `sp-candidates-guild-other-${Date.now()}`;
      const { tournamentId: target } = await makeTournamentWithCharts(guildId, 0);
      await makeTournamentWithCharts(otherGuildId, 3, { state: 'COMPLETE' });
      try {
        expect(await listImportCandidates(prisma, guildId, target)).toEqual([]);
      } finally {
        await dropGuild(guildId);
        await dropGuild(otherGuildId);
      }
    });
  });

  describe('importFromPreviousTournament', () => {
    it('copies every chart regardless of which pools are checked, and recreates only the checked pool\'s labels under new chart ids', async () => {
      const guildId = `sp-import-${Date.now()}`;
      const { tournamentId: sourceId, chartIds: sourceChartIds } = await makeTournamentWithCharts(guildId, 3);
      await createSongPoolTab(prisma, sourceId, HB11, ACTOR);
      await saveSongPoolLabels(prisma, sourceId, HB11, { [sourceChartIds[0]!]: 'RD1', [sourceChartIds[1]!]: 'RD2' }, ACTOR);
      await markComplete(sourceId);
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0);
      try {
        const result = await importFromPreviousTournament(prisma, targetId, sourceId, [HB11], ACTOR);
        expect(result).toEqual({ importedCharts: 3, importedFormatKeys: [HB11] });

        const targetCharts = await prisma.chart.findMany({ where: { tournamentId: targetId } });
        expect(targetCharts).toHaveLength(3);
        expect(targetCharts.map((c) => c.title).sort()).toEqual(['Song 0', 'Song 1', 'Song 2']);
        // Fresh ids, not the source's own — a copy, not a reassignment.
        expect(targetCharts.map((c) => c.id).sort()).not.toEqual([...sourceChartIds].sort());

        const targetTabs = await listSongPoolTabs(prisma, targetId);
        expect(targetTabs).toHaveLength(1);
        expect(targetTabs[0]!.formatKey).toBe(HB11);
        expect(Object.values(targetTabs[0]!.assignments).sort()).toEqual(['RD1', 'RD2']);
        // Assignments point at the new chart ids, not the source's.
        expect(Object.keys(targetTabs[0]!.assignments).every((id) => targetCharts.some((c) => c.id === id))).toBe(true);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('does not create a pool tab, or copy any labels, for a formatKey the caller checked but the target left unchecked', async () => {
      const guildId = `sp-import-partial-${Date.now()}`;
      const { tournamentId: sourceId, chartIds: sourceChartIds } = await makeTournamentWithCharts(guildId, 2);
      await createSongPoolTab(prisma, sourceId, HB11, ACTOR);
      await saveSongPoolLabels(prisma, sourceId, HB11, { [sourceChartIds[0]!]: 'RD1' }, ACTOR);
      await markComplete(sourceId);
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0);
      try {
        // formatKeys: [] — no pools checked, but every song still comes over.
        const result = await importFromPreviousTournament(prisma, targetId, sourceId, [], ACTOR);
        expect(result).toEqual({ importedCharts: 2, importedFormatKeys: [] });
        expect(await prisma.chart.count({ where: { tournamentId: targetId } })).toBe(2);
        expect(await listSongPoolTabs(prisma, targetId)).toEqual([]);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('silently drops a requested formatKey the source has no tab for', async () => {
      const guildId = `sp-import-unknown-format-${Date.now()}`;
      const { tournamentId: sourceId } = await makeTournamentWithCharts(guildId, 1, { state: 'COMPLETE' });
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0);
      try {
        const result = await importFromPreviousTournament(prisma, targetId, sourceId, [HB11], ACTOR);
        expect(result).toEqual({ importedCharts: 1, importedFormatKeys: [] });
      } finally {
        await dropGuild(guildId);
      }
    });

    it('unions into an existing target tab rather than overwriting it — a label may end up double-assigned, and that is left as-is', async () => {
      const guildId = `sp-import-union-${Date.now()}`;
      const { tournamentId: sourceId, chartIds: sourceChartIds } = await makeTournamentWithCharts(guildId, 1);
      await createSongPoolTab(prisma, sourceId, HB11, ACTOR);
      await saveSongPoolLabels(prisma, sourceId, HB11, { [sourceChartIds[0]!]: 'FT1' }, ACTOR);
      await markComplete(sourceId);

      const { tournamentId: targetId, chartIds: targetChartIds } = await makeTournamentWithCharts(guildId, 1);
      await createSongPoolTab(prisma, targetId, HB11, ACTOR);
      await saveSongPoolLabels(prisma, targetId, HB11, { [targetChartIds[0]!]: 'FT1' }, ACTOR);
      try {
        await importFromPreviousTournament(prisma, targetId, sourceId, [HB11], ACTOR);

        const targetTabs = await listSongPoolTabs(prisma, targetId);
        expect(targetTabs).toHaveLength(1); // still exactly one tab, not a duplicate
        // Both the pre-existing assignment and the imported one survive —
        // "FT1" now names two charts, which `validateSongPool` reports as
        // a duplicate but does not block or drop.
        expect(Object.values(targetTabs[0]!.assignments)).toEqual(['FT1', 'FT1']);
        const issues = await prisma.$transaction((tx) => validateSongPool(tx, targetId, HB11));
        expect(issues?.duplicateLabels['FT1']).toHaveLength(2);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses a tournament importing from itself', async () => {
      const guildId = `sp-import-self-${Date.now()}`;
      const { tournamentId } = await makeTournamentWithCharts(guildId, 1, { state: 'COMPLETE' });
      try {
        await expect(importFromPreviousTournament(prisma, tournamentId, tournamentId, [], ACTOR)).rejects.toThrow(PreviousEventImportError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('refuses a source tournament from a different guild', async () => {
      const guildId = `sp-import-cross-guild-${Date.now()}`;
      const otherGuildId = `sp-import-cross-guild-other-${Date.now()}`;
      const { tournamentId: sourceId } = await makeTournamentWithCharts(otherGuildId, 1, { state: 'COMPLETE' });
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0);
      try {
        await expect(importFromPreviousTournament(prisma, targetId, sourceId, [], ACTOR)).rejects.toThrow(PreviousEventImportError);
      } finally {
        await dropGuild(guildId);
        await dropGuild(otherGuildId);
      }
    });

    // No test for "source hasn't finished yet" in the same guild: the
    // database's own `one_active_tournament_per_guild` partial unique
    // index (COMPLETE/CANCELLED excluded) already guarantees a second,
    // still-active tournament can never coexist with the target in the
    // same guild — the check exists as defense in depth (and documents
    // the invariant), but integration-testing it here would mean
    // constructing guild state Postgres itself refuses to hold.

    it('refuses once the target tournament can no longer import a pack', async () => {
      const guildId = `sp-import-target-started-${Date.now()}`;
      const { tournamentId: sourceId } = await makeTournamentWithCharts(guildId, 1, { state: 'COMPLETE', name: 'source' });
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0, { state: 'RUNNING', name: 'target' });
      try {
        await expect(importFromPreviousTournament(prisma, targetId, sourceId, [], ACTOR)).rejects.toThrow(PreviousEventImportError);
      } finally {
        await dropGuild(guildId);
      }
    });

    it('imports 0 charts and no pools from a source with an empty pack', async () => {
      const guildId = `sp-import-empty-${Date.now()}`;
      const { tournamentId: sourceId } = await makeTournamentWithCharts(guildId, 0, { state: 'COMPLETE' });
      const { tournamentId: targetId } = await makeTournamentWithCharts(guildId, 0);
      try {
        const result = await importFromPreviousTournament(prisma, targetId, sourceId, [HB11], ACTOR);
        expect(result).toEqual({ importedCharts: 0, importedFormatKeys: [] });
      } finally {
        await dropGuild(guildId);
      }
    });
  });
});
