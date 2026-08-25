import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';
import { handleSetup } from './setup.js';

async function notImplemented(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ ephemeral: true, content: "This command isn't available yet." });
}

/** Dispatches a chat-input (slash) interaction by its top-level command name. */
export async function dispatchChatInputCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  switch (interaction.commandName) {
    case 'setup':
      return handleSetup(interaction, ctx);
    default:
      return notImplemented(interaction);
  }
}
