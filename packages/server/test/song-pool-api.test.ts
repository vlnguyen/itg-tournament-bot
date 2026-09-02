import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORMAT_SONG_LABELS } from '@itg/shared';
import { SongPoolController } from '../src/api/song-pool.controller.js';
import { TierService } from '../src/auth/tier.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { isReachable, prisma } from './support.js';

const TO = 'to-user';
const HB11 = 'hb11-static-pool';

describe.skipIf(!(await isReachable()))('GET/POST/DELETE/PUT /api/tournaments/:id/song-pools', () => {
  let guildId: string;
  let tournamentId: string;
  let chartIds: string[];
  let controller: SongPoolController;
  let hasTierResult: boolean;

  beforeAll(async () => {
    guildId = `api-songpool-${Date.now()}`;
    await prisma.guild.create({ data: { id: guildId } });
    const tournament = await prisma.tournament.create({
      data: { guildId, name: 'T', defaultFormatKey: HB11, config: {} },
    });
    tournamentId = tournament.id;
    chartIds = [];
    for (let i = 0; i < FORMAT_SONG_LABELS[HB11]!.length; i++) {
      const c = await prisma.chart.create({
        data: { tournamentId, title: `Song ${i}`, playStyle: 'SINGLE', difficulty: 'EXPERT', meter: 12 },
      });
      chartIds.push(c.id);
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [SongPoolController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: TierService, useValue: { hasTier: async () => hasTierResult } },
      ],
    }).compile();
    controller = moduleRef.get(SongPoolController);
  });
  afterAll(async () => {
    await prisma.guild.delete({ where: { id: guildId } }).catch(() => undefined);
  });

  describe('GET :id/song-pools', () => {
    it('404s for a tournament that does not exist', async () => {
      await expect(controller.getSongPools('does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is public — no tier required — and starts empty', async () => {
      const result = await controller.getSongPools(tournamentId);
      expect(result).toEqual({ tabs: [] });
    });
  });

  describe('POST :id/song-pools', () => {
    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.createSongPool(tournamentId, { formatKey: HB11 }, TO)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a malformed body with 400', async () => {
      hasTierResult = true;
      await expect(controller.createSongPool(tournamentId, { formatKey: 123 }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a format with no static song pool', async () => {
      hasTierResult = true;
      await expect(controller.createSongPool(tournamentId, { formatKey: 'bo5-protect-veto' }, TO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates the tab, and a GET now returns it', async () => {
      hasTierResult = true;
      const result = await controller.createSongPool(tournamentId, { formatKey: HB11 }, TO);
      expect(result).toEqual({ formatKey: HB11 });
      expect(await controller.getSongPools(tournamentId)).toEqual({ tabs: [{ formatKey: HB11, assignments: {} }] });
    });

    it('rejects creating a second tab for the same format', async () => {
      hasTierResult = true;
      await expect(controller.createSongPool(tournamentId, { formatKey: HB11 }, TO)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('PUT :id/song-pools/:formatKey/labels', () => {
    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.saveSongPoolLabels(tournamentId, HB11, { assignments: {} }, TO)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects a malformed body with 400', async () => {
      hasTierResult = true;
      await expect(controller.saveSongPoolLabels(tournamentId, HB11, { assignments: 'nope' }, TO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('persists a partial set and reports the missing labels, without blocking', async () => {
      hasTierResult = true;
      const labels = FORMAT_SONG_LABELS[HB11]!;
      const assignments = { [chartIds[0]!]: labels[0]! };
      const result = await controller.saveSongPoolLabels(tournamentId, HB11, { assignments }, TO);
      expect(result.assignments).toEqual(assignments);
      expect(result.issues?.missingLabels.length).toBe(labels.length - 1);
    });

    it('returns null issues once the pool is complete', async () => {
      hasTierResult = true;
      const labels = FORMAT_SONG_LABELS[HB11]!;
      const assignments = Object.fromEntries(chartIds.map((id, i) => [id, labels[i]!]));
      const result = await controller.saveSongPoolLabels(tournamentId, HB11, { assignments }, TO);
      expect(result.issues).toBeNull();
    });
  });

  describe('DELETE :id/song-pools/:formatKey', () => {
    it('rejects a signed-in user below Tournament Organizer tier', async () => {
      hasTierResult = false;
      await expect(controller.deleteSongPool(tournamentId, HB11, TO)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('400s deleting a format with no tab, once tier passes', async () => {
      hasTierResult = true;
      await expect(controller.deleteSongPool(tournamentId, 'hb13-static-pool', TO)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deletes the tab and its labels', async () => {
      hasTierResult = true;
      expect(await controller.deleteSongPool(tournamentId, HB11, TO)).toEqual({ deleted: true });
      expect(await controller.getSongPools(tournamentId)).toEqual({ tabs: [] });
      expect(await prisma.chartLabel.count({ where: { tournamentId, formatKey: HB11 } })).toBe(0);
    });
  });
});
