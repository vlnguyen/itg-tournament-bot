import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { findPublicCurrentTournament } from '../../services/tournament-service.js';
import type { CommandContext } from './context.js';

/**
 * `/rules` — the same shape as `/pack`: answered ephemerally, resolves the
 * current tournament only, and says plainly when nothing's posted rather
 * than erroring. An embed, not plain content, since rules text can run
 * well past a plain reply's 2000-character limit — an embed description
 * has headroom out to 4096.
 */
export async function handleRules(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'This only works inside a server.' });
    return;
  }

  const tournament = await findPublicCurrentTournament(ctx.prisma, interaction.guildId!);
  if (!tournament) {
    await interaction.reply({ ephemeral: true, content: "There's no tournament running." });
    return;
  }

  if (!tournament.rules) {
    await interaction.reply({ ephemeral: true, content: 'No rules have been posted for this tournament yet.' });
    return;
  }

  const embed = new EmbedBuilder().setTitle(`${tournament.name} — Rules`).setDescription(tournament.rules.slice(0, 4096));
  await interaction.reply({ ephemeral: true, embeds: [embed] });
}
