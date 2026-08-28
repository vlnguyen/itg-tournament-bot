import type { Guild as GuildRow, Tournament } from '@prisma/client';
import type { Guild as DiscordGuild } from 'discord.js';
import { describeGap } from './permission-diagnostic.js';
import { runFullDiagnostic, TIER_ROLE_LABELS } from './setup-effects.js';
import type { CommandContext } from './commands/context.js';
import type { ThreadRef } from './ports.js';
import { provisionReadyThreads } from './thread-provisioning.js';
import { hasTier, Tier } from './tier.js';
import { startTournament, TournamentTransitionError } from '../services/tournament-service.js';

function describePreflightFailure(diag: Awaited<ReturnType<typeof runFullDiagnostic>>): string {
  const lines = ["Can't start. Discord isn't fully set up yet:"];
  for (const role of diag.missingTierRoles) {
    lines.push(`- The ${TIER_ROLE_LABELS[role]} role is not configured. Run \`/setup roles\`.`);
  }
  for (const role of diag.deletedTierRoles) {
    lines.push(`- The configured ${TIER_ROLE_LABELS[role]} role no longer exists. Run \`/setup roles\`.`);
  }
  for (const slot of diag.missingChannels) {
    lines.push(`- The configured ${slot} channel no longer exists. Run \`/setup channels\`.`);
  }
  for (const gap of diag.gaps) {
    lines.push(`- ${describeGap({ permission: gap.permission, layer: gap.layer }, gap.targetLabel, `<#${gap.channelId}>`)}`);
  }
  lines.push('', 'Run `/setup status` to see the full diagnostic and fix these, then try again.');
  return lines.join('\n');
}

export type StartTournamentEffectsResult =
  | { kind: 'BLOCKED'; message: string }
  | { kind: 'TRANSITION_ERROR'; reason: string }
  | {
      kind: 'STARTED';
      tournament: Tournament;
      threads: ThreadRef[];
      packSizeWarning: { recommended: number; actual: number } | null;
      refereePoolEmpty: boolean;
      holdsTierRole: string[];
    };

/**
 * `CHECKIN_CLOSED → RUNNING`. Everything Discord-shaped that
 * `tournament-service.ts`'s `startTournament` deliberately leaves out: the
 * blocking permission preflight (reusing `/setup`'s own diagnostic), the
 * non-blocking tier-role-overlap warning ("tournament start warns if any
 * entrant also holds a tier role, naming them" — REQUIREMENTS.md, "Roles"),
 * the live display-name snapshot, and provisioning round 1's threads.
 *
 * One implementation, shared by `/tournament start` and the web console's
 * Start button (`LifecycleController`) — a start blocked from one surface
 * is blocked identically from the other, same principle "Ports and
 * Adapters" already gives referee overrides. The web caller reaches this
 * through its own injected `DISCORD_CLIENT`, the same sanctioned adapter
 * boundary `TierService` and the admin server list already cross; nothing
 * about the transports needs a `discord.js` type of its own, since this
 * function is the one place that translates.
 */
export async function startTournamentWithDiscordEffects(
  ctx: CommandContext,
  guild: DiscordGuild,
  guildRow: GuildRow,
  tournamentId: string,
  actorId: string,
): Promise<StartTournamentEffectsResult> {
  const diag = await runFullDiagnostic(guild, guildRow);
  const blocking = diag.gaps.length > 0 || diag.missingChannels.length > 0 || diag.missingTierRoles.length > 0 || diag.deletedTierRoles.length > 0;
  if (blocking) {
    return { kind: 'BLOCKED', message: describePreflightFailure(diag) };
  }

  const entrants = await ctx.prisma.entrant.findMany({
    where: { tournamentId, status: 'ACTIVE', checkedIn: true },
  });
  const displayNames = new Map<string, string>();
  const holdsTierRole: string[] = [];
  for (const e of entrants) {
    const member = await guild.members.fetch(e.discordUserId).catch(() => null);
    if (!member) continue; // left the guild — seated anyway; nothing here to snapshot or warn on
    displayNames.set(e.id, member.displayName);
    if (hasTier(member.roles.cache.keys(), guildRow, Tier.REFEREE)) holdsTierRole.push(member.displayName);
  }

  let result;
  try {
    result = await startTournament(ctx.prisma, ctx.random, tournamentId, displayNames, actorId);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      return { kind: 'TRANSITION_ERROR', reason: err.reason };
    }
    throw err;
  }

  const threads = await provisionReadyThreads(ctx.prisma, ctx.matchChannel, ctx.playerNotification, tournamentId, result.tournament.name);

  return {
    kind: 'STARTED',
    tournament: result.tournament,
    threads,
    packSizeWarning: result.packSizeWarning,
    refereePoolEmpty: diag.refereePoolEmpty,
    holdsTierRole,
  };
}
