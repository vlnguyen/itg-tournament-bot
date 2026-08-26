import { ChannelType, SlashCommandBuilder } from 'discord.js';

/**
 * Every slash command this bot registers, guild-scoped — matches this
 * project's single-test-server stage; global registration is a later
 * concern. Handlers live in this directory's other files; this module is
 * only the shape Discord needs to build the command picker.
 *
 * Every command's own authorization (tier, or the Manage Guild/Server
 * Administrator check `/setup` uses) is enforced inside its handler, not
 * via Discord's `setDefaultMemberPermissions` — that API can't express
 * "this configured role or that one," which is exactly what a guild's
 * tier roles are. See DESIGN.md, "Three tiers of privilege".
 */

const setup = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure this server for the tournament bot')
  .addSubcommand((sub) =>
    sub
      .setName('channels')
      .setDescription('Point the bot at (or create) the matches/alerts/results/general channels')
      .addChannelOption((o) =>
        o.setName('matches').setDescription('Existing matches channel — omit to create one').addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o.setName('alerts').setDescription('Existing organizer alert channel — omit to create one').addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o.setName('results').setDescription('Existing results channel — omit to create one').addChannelTypes(ChannelType.GuildText),
      )
      .addChannelOption((o) =>
        o.setName('general').setDescription('Existing general channel to forward results to').addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('roles')
      .setDescription('Point the bot at (or create) the referee/organizer tier roles')
      .addRoleOption((o) => o.setName('referee').setDescription('Referee tier — may rule on matches'))
      .addRoleOption((o) => o.setName('organizer').setDescription('Tournament Organizer tier — may run tournaments')),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Re-run the setup diagnostic'));

const tournament = new SlashCommandBuilder()
  .setName('tournament')
  .setDescription('Run the tournament lifecycle')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new tournament in this server')
      .addStringOption((o) => o.setName('name').setDescription('Tournament name').setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('See the current tournament and what you can do right now'))
  .addSubcommand((sub) => sub.setName('open-registration').setDescription('Open registration — /join starts working'))
  .addSubcommand((sub) => sub.setName('close-registration').setDescription('Close registration — /join stops working'))
  .addSubcommand((sub) => sub.setName('open-checkin').setDescription('Open check-in and notify registered players'))
  .addSubcommand((sub) => sub.setName('close-checkin').setDescription('Close check-in and normalize seeds'))
  .addSubcommand((sub) => sub.setName('start').setDescription('Start the tournament — generates the bracket and provisions threads'))
  .addSubcommand((sub) => sub.setName('cancel').setDescription('Cancel the tournament'))
  .addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename the tournament this server is holding')
      .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true)),
  );

const roster = new SlashCommandBuilder()
  .setName('roster')
  .setDescription('Act on a player’s behalf')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Register a player who missed registration')
      .addUserOption((o) => o.setName('player').setDescription('The player').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('checkin')
      .setDescription('Check a player in on their behalf')
      .addUserOption((o) => o.setName('player').setDescription('The player').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('uncheckin')
      .setDescription('Undo a player’s check-in')
      .addUserOption((o) => o.setName('player').setDescription('The player').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Withdraw a player from the tournament')
      .addUserOption((o) => o.setName('player').setDescription('The player').setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('See who is on the tournament roster'));

const join = new SlashCommandBuilder().setName('join').setDescription('Register for the current tournament');
const checkin = new SlashCommandBuilder().setName('checkin').setDescription('Check yourself in');
const leave = new SlashCommandBuilder().setName('leave').setDescription('Withdraw from the tournament');

const dq = new SlashCommandBuilder()
  .setName('dq')
  .setDescription('Disqualify a player, or forfeit them out of this match (referee)')
  .addStringOption((o) =>
    o
      .setName('scope')
      .setDescription('This match (also how you apply a plain forfeit), or the whole tournament')
      .setRequired(true)
      .addChoices({ name: 'This match', value: 'match' }, { name: 'Whole tournament', value: 'tournament' }),
  )
  .addStringOption((o) =>
    o
      .setName('player')
      .setDescription('The player to disqualify')
      .setRequired(true)
      .setAutocomplete(true),
  );

const pack = new SlashCommandBuilder().setName('pack').setDescription('Show a summary of the tournament’s chart pack');

const commands = new SlashCommandBuilder().setName('commands').setDescription('List every command, grouped by who can run it');

export const commandDefinitions = [setup, tournament, roster, join, checkin, leave, dq, pack, commands];
