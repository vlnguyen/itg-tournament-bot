import type { SaveSongPoolLabelsResponse, SongPoolTabsResponse } from '@itg/shared';
import { CreateSongPoolTabRequest, SaveSongPoolLabelsRequest } from '@itg/shared';
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { Tier } from '../discord/tier.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createSongPoolTab, deleteSongPoolTab, listSongPoolTabs, saveSongPoolLabels, SongPoolTabError } from '../services/song-pool-service.js';

/**
 * `/api/tournaments/:id/song-pools` — the static-pool tabs of the pack view
 * (NEW_FORMAT.md's "Song Pool"). Mirrors `charts.controller.ts`'s split:
 * the read is public (same as `GET :id/charts`, the "All Songs" tab it
 * sits beside), every write needs Tournament Organizer tier.
 */
@Controller('api/tournaments')
export class SongPoolController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
  ) {}

  private async requireTournament(id: string) {
    const tournament = await this.prisma.tournament.findUnique({ where: { id } });
    if (!tournament) throw new NotFoundException(`no tournament ${id}`);
    return tournament;
  }

  private async requireOrganizer(guildId: string, discordUserId: string | null, action: string): Promise<void> {
    if (!discordUserId || !(await this.tierService.hasTier(guildId, discordUserId, Tier.TOURNAMENT_ORGANIZER))) {
      throw new ForbiddenException(`You need Tournament Organizer tier to ${action}.`);
    }
  }

  @Get(':id/song-pools')
  async getSongPools(@Param('id') id: string): Promise<SongPoolTabsResponse> {
    await this.requireTournament(id);
    return { tabs: await listSongPoolTabs(this.prisma, id) };
  }

  @Post(':id/song-pools')
  async createSongPool(@Param('id') id: string, @Body() body: unknown, @CurrentUser() discordUserId: string | null): Promise<{ formatKey: string }> {
    const tournament = await this.requireTournament(id);
    await this.requireOrganizer(tournament.guildId, discordUserId, 'create a song pool tab');

    let request: CreateSongPoolTabRequest;
    try {
      request = CreateSongPoolTabRequest.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    try {
      await createSongPoolTab(this.prisma, id, request.formatKey, discordUserId!);
    } catch (err) {
      if (err instanceof SongPoolTabError) throw new BadRequestException(err.message);
      throw err;
    }
    return { formatKey: request.formatKey };
  }

  @Delete(':id/song-pools/:formatKey')
  async deleteSongPool(
    @Param('id') id: string,
    @Param('formatKey') formatKey: string,
    @CurrentUser() discordUserId: string | null,
  ): Promise<{ deleted: true }> {
    const tournament = await this.requireTournament(id);
    await this.requireOrganizer(tournament.guildId, discordUserId, 'delete a song pool tab');

    try {
      await deleteSongPoolTab(this.prisma, id, formatKey, discordUserId!);
    } catch (err) {
      if (err instanceof SongPoolTabError) throw new BadRequestException(err.message);
      throw err;
    }
    return { deleted: true };
  }

  @Put(':id/song-pools/:formatKey/labels')
  async saveSongPoolLabels(
    @Param('id') id: string,
    @Param('formatKey') formatKey: string,
    @Body() body: unknown,
    @CurrentUser() discordUserId: string | null,
  ): Promise<SaveSongPoolLabelsResponse> {
    const tournament = await this.requireTournament(id);
    await this.requireOrganizer(tournament.guildId, discordUserId, 'edit a song pool');

    let request: SaveSongPoolLabelsRequest;
    try {
      request = SaveSongPoolLabelsRequest.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    let issues;
    try {
      issues = await saveSongPoolLabels(this.prisma, id, formatKey, request.assignments, discordUserId!);
    } catch (err) {
      if (err instanceof SongPoolTabError) throw new BadRequestException(err.message);
      throw err;
    }
    return { assignments: request.assignments, issues };
  }
}
