import type { ChatInputCommandInteraction } from 'discord.js';
import { findPublicCurrentTournament } from '../../services/tournament-service.js';
import { webUrl } from '../../web-url.js';
import type { CommandContext } from './context.js';

/**
 * `/pack` — "Returns a link to the pack tab for the server's current
 * tournament, answered ephemerally like every other competitor command...
 * With no tournament accepting entrants it says so rather than erroring.
 * It resolves the current tournament only; a link to a past pack comes
 * from that tournament's archived page, which is permanent anyway." See
 * DESIGN.md, "`/pack`".
 */
export async function handlePack(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const tournament = await findPublicCurrentTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.reply({ ephemeral: true, content: "There's no tournament running right now." });
    return;
  }

  const url = webUrl(`/t/${tournament.id}/pack`);
  await interaction.reply({ ephemeral: true, content: `**${tournament.name}**'s song pack: ${url}` });
}
