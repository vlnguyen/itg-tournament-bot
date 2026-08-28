import type { ChannelSlot, GuildOption, SetupChannelsRequest, SetupRolesRequest, SetupStatus as SetupStatusWire, TierRoleSlot } from '@itg/shared';
import {
  plural,
  SetupChannelsRequest as SetupChannelsRequestSchema,
  SetupRolesRequest as SetupRolesRequestSchema,
  SetupStatus as SetupStatusSchema,
} from '@itg/shared';
import type { Guild as GuildRow } from '@prisma/client';
import { ChannelType, type Client, type Guild as DiscordGuild, type TextChannel } from 'discord.js';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ZodError } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { TierService } from '../auth/tier.service.js';
import { DISCORD_CLIENT } from '../discord/discord.tokens.js';
import { describeGap } from '../discord/permission-diagnostic.js';
import { isRepairable, type ChannelGap } from '../discord/setup-diagnostic.js';
import {
  applyRepairs,
  EMPTY_TIER_CONFIG,
  resolveChannelSetup,
  resolveRoleSetup,
  runFullDiagnostic,
  type ChannelPick,
  type FullDiagnostic,
} from '../discord/setup-effects.js';
import { refereeTierRoleIds } from '../discord/tier.js';
import { logAction } from '../services/audit-log.js';
import { PrismaService } from '../prisma/prisma.service.js';

const NOT_CONFIGURED_DIAGNOSTIC: FullDiagnostic = {
  gaps: [],
  refereePoolEmpty: false,
  missingChannels: [],
  missingTierRoles: ['referee', 'organizer'],
  deletedTierRoles: [],
};

/**
 * `GET`/`POST /api/guilds/:guildId/setup*` — the web console's server
 * reconfiguration panel, DESIGN.md's "the one panel outside [the tier]
 * filter... gated on Manage Guild the same way `/setup` is, not on a
 * tier." Every mutation runs through `discord/setup-effects.ts`, the exact
 * logic `/setup channels`/`/setup roles` use, so a binding made from the
 * console and one made from Discord are indistinguishable in effect.
 */
@Controller('api/guilds')
export class SetupController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TierService) private readonly tierService: TierService,
    @Inject(DISCORD_CLIENT) private readonly client: Client,
  ) {}

  private async requireManageGuild(guildId: string, discordUserId: string | null): Promise<DiscordGuild> {
    const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException("The bot isn't in this server.");
    if (!discordUserId || !(await this.tierService.hasManageGuild(guildId, discordUserId))) {
      throw new ForbiddenException('You need Manage Server to reconfigure this server.');
    }
    return guild;
  }

  @Get(':guildId/setup')
  async getStatus(@Param('guildId') guildId: string, @CurrentUser() discordUserId: string | null): Promise<SetupStatusWire> {
    const guild = await this.requireManageGuild(guildId, discordUserId);
    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    return this.buildStatus(guild, guildRow);
  }

  @Post(':guildId/setup/channels')
  async postChannels(
    @Param('guildId') guildId: string,
    @Body() body: unknown,
    @CurrentUser() discordUserId: string | null,
  ): Promise<SetupStatusWire> {
    const guild = await this.requireManageGuild(guildId, discordUserId);

    let request: SetupChannelsRequest;
    try {
      request = SetupChannelsRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    const given: Partial<Record<ChannelSlot, ChannelPick>> = {};
    for (const slot of ['matches', 'alerts', 'results', 'general'] as const) {
      if (request[slot]) given[slot] = request[slot];
    }

    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    const tierRoleIds = refereeTierRoleIds(guildRow ?? EMPTY_TIER_CONFIG);
    const { resolved, notes } = await resolveChannelSetup(guild, guildRow, given, tierRoleIds, this.client.user!.id);

    await this.prisma.guild.upsert({
      where: { id: guildId },
      create: {
        id: guildId,
        matchesChannelId: resolved.matches,
        alertChannelId: resolved.alerts,
        resultsChannelId: resolved.results,
        generalChannelId: resolved.general,
      },
      update: {
        matchesChannelId: resolved.matches,
        alertChannelId: resolved.alerts,
        resultsChannelId: resolved.results,
        generalChannelId: resolved.general,
      },
    });
    await logAction(this.prisma, discordUserId!, 'SETUP_CHANNELS', 'Guild', guildId, resolved);

    const updatedRow = await this.prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
    return this.buildStatus(guild, updatedRow, notes);
  }

  @Post(':guildId/setup/roles')
  async postRoles(
    @Param('guildId') guildId: string,
    @Body() body: unknown,
    @CurrentUser() discordUserId: string | null,
  ): Promise<SetupStatusWire> {
    const guild = await this.requireManageGuild(guildId, discordUserId);

    let request: SetupRolesRequest;
    try {
      request = SetupRolesRequestSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) throw new BadRequestException(err.issues);
      throw err;
    }

    const given: Partial<Record<TierRoleSlot, ChannelPick>> = {};
    for (const slot of ['referee', 'organizer'] as const) {
      if (request[slot]) given[slot] = request[slot];
    }

    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    const { resolved, notes } = await resolveRoleSetup(guild, guildRow, given);

    await this.prisma.guild.upsert({
      where: { id: guildId },
      create: { id: guildId, refereeRoleId: resolved.referee, toRoleId: resolved.organizer },
      update: { refereeRoleId: resolved.referee, toRoleId: resolved.organizer },
    });
    await logAction(this.prisma, discordUserId!, 'SETUP_ROLES', 'Guild', guildId, resolved);

    const updatedRow = await this.prisma.guild.findUniqueOrThrow({ where: { id: guildId } });
    return this.buildStatus(guild, updatedRow, notes);
  }

  @Post(':guildId/setup/repair')
  async postRepair(@Param('guildId') guildId: string, @CurrentUser() discordUserId: string | null): Promise<SetupStatusWire> {
    const guild = await this.requireManageGuild(guildId, discordUserId);
    const guildRow = await this.prisma.guild.findUnique({ where: { id: guildId } });
    if (!guildRow) throw new BadRequestException("Nothing to repair yet: this server hasn't been configured.");

    const diag = await runFullDiagnostic(guild, guildRow);
    const repairable = diag.gaps.filter(isRepairable);
    const results = await applyRepairs(guild, repairable);
    await logAction(this.prisma, discordUserId!, 'SETUP_REPAIR', 'Guild', guildId, {
      attempted: repairable.length,
      failed: results.failed,
    });

    const notes = [
      results.failed.length === 0
        ? `Repaired ${plural(results.succeeded, 'overwrite', 'overwrites')}.`
        : `Repaired ${plural(results.succeeded, 'overwrite', 'overwrites')}; couldn't repair: ${results.failed.join('; ')}.`,
    ];
    return this.buildStatus(guild, guildRow, notes);
  }

  private channelLabel(guild: DiscordGuild, gap: ChannelGap): string {
    const channel = guild.channels.cache.get(gap.channelId);
    return channel && 'name' in channel ? `#${channel.name}` : 'that channel';
  }

  private async buildStatus(guild: DiscordGuild, guildRow: GuildRow | null, notes: string[] = []): Promise<SetupStatusWire> {
    const diag = guildRow ? await runFullDiagnostic(guild, guildRow) : NOT_CONFIGURED_DIAGNOSTIC;

    const gapDescriptions = diag.gaps.map((gap) =>
      describeGap({ permission: gap.permission, layer: gap.layer }, gap.targetLabel, this.channelLabel(guild, gap)),
    );

    const channels: GuildOption[] = [...guild.channels.cache.values()]
      .filter((c): c is TextChannel => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const roles: GuildOption[] = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return SetupStatusSchema.parse({
      bindings: {
        matches: guildRow?.matchesChannelId ?? null,
        alerts: guildRow?.alertChannelId ?? null,
        results: guildRow?.resultsChannelId ?? null,
        general: guildRow?.generalChannelId ?? null,
        referee: guildRow?.refereeRoleId ?? null,
        organizer: guildRow?.toRoleId ?? null,
      },
      diagnostic: {
        gapDescriptions,
        missingChannels: diag.missingChannels,
        missingTierRoles: diag.missingTierRoles,
        deletedTierRoles: diag.deletedTierRoles,
        refereePoolEmpty: diag.refereePoolEmpty,
        repairableCount: diag.gaps.filter(isRepairable).length,
      },
      channels,
      roles,
      notes,
    });
  }
}
