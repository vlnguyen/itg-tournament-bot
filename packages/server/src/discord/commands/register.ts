import type { Client } from 'discord.js';
import { commandDefinitions } from './definitions.js';

/**
 * Guild-scoped bulk-overwrite registration — `ApplicationCommandManager#set`
 * PUTs the whole command list for one guild in a single request, replacing
 * whatever was registered before. Called at boot for every guild the bot is
 * already in, and again whenever the bot joins a new one, so there is no
 * separate one-off registration script to remember to run.
 */
export async function registerGuildCommands(client: Client, guildId: string): Promise<void> {
  if (!client.application) throw new Error('registerGuildCommands: client application is not ready');
  await client.application.commands.set(commandDefinitions, guildId);
}

export async function registerCommandsForAllGuilds(client: Client): Promise<void> {
  for (const guildId of client.guilds.cache.keys()) {
    await registerGuildCommands(client, guildId);
  }
}
