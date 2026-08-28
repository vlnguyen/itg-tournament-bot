import { ApplicationCommandOptionType, EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './context.js';
import { commandDefinitions } from './definitions.js';

/**
 * `/commands` — a discoverability index over `commandDefinitions`, grouped
 * by the minimum role each command needs. Descriptions are read straight
 * off each `SlashCommandBuilder` rather than duplicated here, so the two
 * can never say something different; only *which group a command belongs
 * to* is maintained by hand below, the same way `TIER_ROLE_LABEL` (setup.ts)
 * and `PHASE_LABEL` (registration.ts) are small hand-kept maps elsewhere in
 * this codebase. See REQUIREMENTS.md, "Granted roles" — the two server
 * tiers are cumulative, and Manage Guild sits outside that ladder entirely.
 */

type Group = 'ANYONE' | 'REFEREE' | 'ORGANIZER' | 'MANAGE_GUILD';

const GROUP_ORDER: readonly Group[] = ['ANYONE', 'REFEREE', 'ORGANIZER', 'MANAGE_GUILD'];

const GROUP_LABEL: Record<Group, string> = {
  ANYONE: 'Anyone',
  REFEREE: 'Referee (and above)',
  ORGANIZER: 'Tournament Organizer (and above)',
  MANAGE_GUILD: "Discord's Manage Server",
};

/** Whole-command entries — every subcommand they have (if any) shares one gate. */
const WHOLE_COMMAND_GROUP: Partial<Record<string, Group>> = {
  join: 'ANYONE',
  checkin: 'ANYONE',
  leave: 'ANYONE',
  pack: 'ANYONE',
  commands: 'ANYONE',
  dq: 'REFEREE',
  rule: 'REFEREE',
  setup: 'MANAGE_GUILD',
};

/**
 * The two commands whose subcommands don't share one gate — `status` and
 * `list` are carved out ahead of their command's own organizer-tier check
 * in `tournament.ts` and `roster.ts` respectively, so they're listed here
 * subcommand by subcommand instead of once for the whole command.
 */
export const SUBCOMMAND_GROUP: Partial<Record<string, Partial<Record<string, Group>>>> = {
  tournament: {
    status: 'ANYONE',
    create: 'ORGANIZER',
    'open-registration': 'ORGANIZER',
    'close-registration': 'ORGANIZER',
    'open-checkin': 'ORGANIZER',
    'close-checkin': 'ORGANIZER',
    start: 'ORGANIZER',
    cancel: 'ORGANIZER',
    rename: 'ORGANIZER',
    format: 'ORGANIZER',
  },
  roster: {
    list: 'ANYONE',
    add: 'ORGANIZER',
    checkin: 'ORGANIZER',
    uncheckin: 'ORGANIZER',
    remove: 'ORGANIZER',
  },
};

interface Entry {
  group: Group;
  usage: string;
  description: string;
}

export function collectEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const builder of commandDefinitions) {
    const json = builder.toJSON();
    const perSubcommand = SUBCOMMAND_GROUP[json.name];
    if (perSubcommand) {
      for (const option of json.options ?? []) {
        if (option.type !== ApplicationCommandOptionType.Subcommand) continue;
        const group = perSubcommand[option.name];
        if (!group) continue; // a gap here is a bug — caught by the test that cross-checks this list against `commandDefinitions`
        entries.push({ group, usage: `/${json.name} ${option.name}`, description: option.description });
      }
      continue;
    }
    const group = WHOLE_COMMAND_GROUP[json.name];
    if (!group) continue;
    entries.push({ group, usage: `/${json.name}`, description: json.description });
  }
  return entries;
}

export async function handleCommands(interaction: ChatInputCommandInteraction, _ctx: CommandContext): Promise<void> {
  const entries = collectEntries();

  const embed = new EmbedBuilder().setTitle('Commands');
  for (const group of GROUP_ORDER) {
    const lines = entries.filter((e) => e.group === group).map((e) => `\`${e.usage}\`: ${e.description}`);
    if (lines.length === 0) continue;
    embed.addFields({ name: GROUP_LABEL[group], value: lines.join('\n') });
  }
  embed.setFooter({ text: 'Tiers are cumulative: a Tournament Organizer can do everything a Referee can.' });

  await interaction.reply({ ephemeral: true, embeds: [embed] });
}
