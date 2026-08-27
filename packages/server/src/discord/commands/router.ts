import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';
import { handleCommands } from './help.js';
import { handlePack } from './pack.js';
import { handleCheckin, handleJoin, handleLeave } from './registration.js';
import { handleRoster } from './roster.js';
import { handleDq, handleDqAutocomplete, handleRule, handleRuleAutocomplete } from './rulings.js';
import { handleSetup } from './setup.js';
import { handleTournament } from './tournament.js';

async function notImplemented(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ ephemeral: true, content: "This command isn't available yet." });
}

/** Dispatches an autocomplete request by top-level command name — `/dq` and `/rule` need one. */
export async function dispatchAutocomplete(interaction: AutocompleteInteraction, ctx: CommandContext): Promise<void> {
  switch (interaction.commandName) {
    case 'dq':
      return handleDqAutocomplete(interaction, ctx);
    case 'rule':
      return handleRuleAutocomplete(interaction, ctx);
    default:
      await interaction.respond([]);
  }
}

/** Dispatches a chat-input (slash) interaction by its top-level command name. */
export async function dispatchChatInputCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  switch (interaction.commandName) {
    case 'setup':
      return handleSetup(interaction, ctx);
    case 'tournament':
      return handleTournament(interaction, ctx);
    case 'join':
      return handleJoin(interaction, ctx);
    case 'checkin':
      return handleCheckin(interaction, ctx);
    case 'leave':
      return handleLeave(interaction, ctx);
    case 'roster':
      return handleRoster(interaction, ctx);
    case 'dq':
      return handleDq(interaction, ctx);
    case 'rule':
      return handleRule(interaction, ctx);
    case 'commands':
      return handleCommands(interaction, ctx);
    case 'pack':
      return handlePack(interaction, ctx);
    default:
      return notImplemented(interaction);
  }
}
