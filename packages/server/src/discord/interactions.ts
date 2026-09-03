import {
  ActionRowBuilder,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { PrismaClient } from '@prisma/client';
import { FORMAT_LABEL, type FormatKey } from '@itg/shared';
import type { EntrantId, MatchEvent, MatchState, PendingAction } from '../domain/types.js';
import { requireFormat } from '../services/engine.js';
import { appendMatchEvent, IllegalActionError } from '../services/match-service.js';
import type { RandomPort, RealtimeBroadcastPort } from '../services/ports.js';
import { setTournamentFormat, TournamentTransitionError } from '../services/tournament-service.js';
import { linkifyTournamentName } from '../web-url.js';
import { Action, SCORE_MODAL_EX_FIELD } from './actions.js';
import type { CommandContext } from './commands/context.js';
import { dispatchAutocomplete, dispatchChatInputCommand } from './commands/router.js';
import { decodeCustomId, decodeTournamentCustomId, encodeCustomId, type CustomId, type TournamentCustomId } from './custom-id.js';
import { renderResetLog, renderRulingLog, renderSetRulingLog } from './log-messages.js';
import { applyAppendResult, CANCELLED_MATCH_MESSAGE, describeStale } from './match-event-effects.js';
import { buildPlayerDirectory, loadMatch } from './match-lookup.js';
import { logToOrganizers, matchLinksBlock } from './commands/organizer-log.js';
import type { AlertPort, MatchChannelPort, PlayerNotificationPort, ThreadRef } from './ports.js';
import { compactChartLabel } from './render/chart.js';
import { LOG_COLOR } from './render/draw.js';
import { buildResolvedAlert } from './render/escalation.js';
import { memberDisplayName } from './member-display-name.js';
import { hasTier, Tier, type TierRoleConfig } from './tier.js';
import { parseExPercent } from './validate-ex.js';
import { displayName } from './state-message.js';

/**
 * The one `interactionCreate` listener. Decodes the stateless `custom_id`,
 * resolves the acting Discord user to an `EntrantId` for this match,
 * builds the domain event, and hands it to `appendMatchEvent` — the same
 * call path a test drives directly. See DESIGN.md, "The three-second
 * rule" and "Stateless components".
 *
 * `deferUpdate()` first, always — with one exception: a "Submit score"
 * button must respond with `showModal()` as its *first* response instead,
 * since deferring and showing a modal are mutually exclusive.
 */
export function registerInteractionHandlers(
  client: Client,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
): void {
  const commandCtx: CommandContext = { client, prisma, random, matchChannel, playerNotification, alert, realtime };
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    handle(interaction, prisma, random, matchChannel, alert, playerNotification, realtime, commandCtx).catch((err: unknown) => {
      console.error('[discord] interaction handler failed', err);
    });
  });
}

async function handle(
  interaction: Interaction,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
  commandCtx: CommandContext,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await dispatchChatInputCommand(interaction, commandCtx);
    return;
  }

  if (interaction.isAutocomplete()) {
    await dispatchAutocomplete(interaction, commandCtx);
    return;
  }

  if (interaction.isModalSubmit()) {
    const decoded = decodeCustomId(interaction.customId);
    if (!decoded || decoded.action !== Action.SCORE) return;
    await handleScoreModalSubmit(interaction, decoded, prisma, random, matchChannel, alert, playerNotification, realtime);
    return;
  }

  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  // Tournament-scoped conflict-resolution buttons — a separate `t1:` codec
  // since these have no matchId at all (see `custom-id.ts`'s comment on
  // why). Checked before the match-scoped `v1:` decode below, which would
  // otherwise just ignore a `t1:` id as "not one of ours."
  if (interaction.isButton()) {
    const tDecoded = decodeTournamentCustomId(interaction.customId);
    if (tDecoded) {
      await handleFormatConflictButton(interaction, tDecoded, prisma, alert, realtime);
      return;
    }
  }

  const decoded = decodeCustomId(interaction.customId);
  if (!decoded) return; // not one of ours

  if (interaction.isButton() && decoded.action === Action.SCORE) {
    await interaction.showModal(buildScoreModal(decoded));
    return;
  }

  // A referee ruling isn't a participant action — gated on tier, not on
  // being seated in the match — so it's routed before the participant
  // check below rather than through the generic path.
  if (interaction.isButton() && decoded.action === Action.RULE) {
    await handleRulingButton(interaction, decoded, prisma, random, matchChannel, alert, playerNotification, realtime);
    return;
  }

  // Same reasoning: a referee resetting Protect/Veto isn't a participant
  // action either.
  if (interaction.isButton() && decoded.action === Action.RESET_PV) {
    await handleResetButton(interaction, decoded, prisma, random, matchChannel, alert, playerNotification, realtime);
    return;
  }

  // The one place the general defer-first rule has a wrong answer:
  // deferUpdate() mutates the shared state message for everyone, which
  // would leak a tiebreak pick to the opponent before it's revealed. See
  // DESIGN.md, "The tiebreak".
  if (interaction.isStringSelectMenu() && decoded.action === Action.TIEBREAK) {
    await handleTiebreakPick(interaction, decoded, prisma, random, matchChannel, alert, playerNotification, realtime);
    return;
  }

  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.followUp({ ephemeral: true, content: "You're not a participant in this match." });
    return;
  }

  const format = requireFormat(match.formatKey);
  // Best-effort peek at the disposable cache to decide, e.g., Protect vs.
  // Veto for the event *type* — never authoritative. `appendMatchEvent`
  // takes the real row lock and re-validates a moment later; a stale read
  // here fails closed (rejected as illegal), never open.
  const cachedPending: PendingAction = format.pendingAction(match.state as unknown as MatchState);

  const event = buildEvent(decoded, interaction, me.entrantId, cachedPending);
  if (!event) {
    await interaction.followUp({ ephemeral: true, content: 'Unrecognized action.' });
    return;
  }

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `This action is not available. ${describeStale(err, buildPlayerDirectory(match))}`,
      });
      return;
    }
    throw err;
  }
}

function buildScoreModal(decoded: CustomId): ModalBuilder {
  // `arg` (the song index) is always set when the state message's button
  // encoded this id in the first place — see renderSubmitScore.
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ matchId: decoded.matchId, action: Action.SCORE, arg: decoded.arg! }))
    .setTitle('Submit your EX%')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(SCORE_MODAL_EX_FIELD)
          .setLabel('EX% (0.00–100.00)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 97.32')
          .setRequired(true)
          .setMaxLength(6),
      ),
    );
}

async function handleScoreModalSubmit(
  interaction: ModalSubmitInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  const raw = interaction.fields.getTextInputValue(SCORE_MODAL_EX_FIELD);
  const ex = parseExPercent(raw);
  if (ex === null) {
    await interaction.reply({
      ephemeral: true,
      content: 'EX% must be a number between 0.00 and 100.00, with at most two decimal places.',
    });
    return;
  }

  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }
  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.followUp({ ephemeral: true, content: "You're not a participant in this match." });
    return;
  }

  const songIndex = Number(decoded.arg);
  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id, // the raw Discord id — see buildEvent's note
    type: 'SCORE_SUBMITTED',
    payload: { songIndex, by: me.entrantId, ex },
  };
  const format = requireFormat(match.formatKey);

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `This action is not available. ${describeStale(err, buildPlayerDirectory(match))}`,
      });
      return;
    }
    throw err;
  }
}

/**
 * Every role's roles come back shaped differently depending on whether
 * discord.js resolved a full cached `GuildMember` or the raw API partial —
 * both carry the same role ids, just under different shapes.
 */
function rolesOfMember(member: ButtonInteraction['member']): string[] {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...member.roles.cache.keys()];
}

/** A referee's name attributed on a ruling/reset log must be how this *server* shows them — nickname if set — never the raw Discord username. */
function refereeDisplayName(interaction: ButtonInteraction): string {
  return memberDisplayName(interaction.member, interaction.user);
}

/**
 * Resolves `setTournamentFormat`'s three-way mixed-format conflict —
 * "update all," "change the default only," or "cancel" — posted by
 * `commands/tournament.ts`'s `handleFormat`. Tournament-scoped, not a
 * participant or a referee action, so tier is checked the same inline way
 * `handleRulingButton` checks Referee tier: against the guild's configured
 * role, not against being seated in a match (there is no match here).
 */
async function handleFormatConflictButton(
  interaction: ButtonInteraction,
  decoded: TournamentCustomId,
  prisma: PrismaClient,
  alert: AlertPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  await interaction.deferUpdate();

  if (decoded.action === Action.FORMAT_CANCEL) {
    await interaction.editReply({ content: 'No change made.', components: [] });
    return;
  }
  if (decoded.action !== Action.FORMAT_UPDATE_ALL && decoded.action !== Action.FORMAT_DEFAULT_ONLY) return;

  const tournament = await prisma.tournament.findUnique({ where: { id: decoded.tournamentId } });
  if (!tournament) {
    await interaction.editReply({ content: 'This tournament no longer exists.', components: [] });
    return;
  }

  const guild = await prisma.guild.findUnique({ where: { id: tournament.guildId } });
  const tierConfig: TierRoleConfig = guild ?? { refereeRoleId: null, toRoleId: null, adminRoleId: null };
  if (!hasTier(rolesOfMember(interaction.member), tierConfig, Tier.TOURNAMENT_ORGANIZER)) {
    await interaction.followUp({ ephemeral: true, content: 'Only a Tournament Organizer can resolve this.' });
    return;
  }

  const formatKey = decoded.arg as FormatKey;
  const mode = decoded.action === Action.FORMAT_UPDATE_ALL ? 'UPDATE_ALL' : 'DEFAULT_ONLY';
  try {
    const t = await setTournamentFormat(prisma, tournament.id, formatKey, interaction.user.id, mode);
    const description = `Format set to **${FORMAT_LABEL[formatKey]}**.`;
    await interaction.editReply({ content: description, components: [] });
    await logToOrganizers(alert, tournament.guildId, `📋 **${interaction.user.username}**: ${linkifyTournamentName(description, t.name, t.id)}`);
    realtime.publishLifecycleChanged(t.id);
  } catch (err) {
    if (err instanceof TournamentTransitionError) {
      await interaction.editReply({ content: `Can't do that: ${err.reason}`, components: [] });
      return;
    }
    throw err;
  }
}

async function handleRulingButton(
  interaction: ButtonInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const guild = await prisma.guild.findUnique({ where: { id: match.tournament.guildId } });
  const tierConfig: TierRoleConfig = guild ?? { refereeRoleId: null, toRoleId: null, adminRoleId: null };
  if (!hasTier(rolesOfMember(interaction.member), tierConfig, Tier.REFEREE)) {
    await interaction.followUp({ ephemeral: true, content: 'Only a referee can rule on this.' });
    return;
  }

  // `state.escalation` (the raw field) is only ever set for an explicit
  // settings-violation report — a winner disagreement is derived from the
  // selections and never stored there. `pendingAction` is the only place
  // it, and the songIndex it applies to, surfaces at all.
  const format = requireFormat(match.formatKey);
  const cachedState = match.state as unknown as MatchState;
  const cachedPending = format.pendingAction(cachedState);
  const arg = decoded.arg;
  if (cachedPending.kind !== 'AWAITING_TO' || !arg) {
    await interaction.followUp({ ephemeral: true, content: 'A referee already resolved this.' });
    return;
  }

  const players = buildPlayerDirectory(match);
  const refDisplayName = refereeDisplayName(interaction);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };

  // A set-level disagreement has no songIndex — it isn't about any one
  // song — and only two possible rulings, never a Void.
  if (cachedPending.reason === 'SET_RESULT_DISAGREEMENT') {
    const winnerId = arg as EntrantId;
    const event: Omit<MatchEvent, 'seq'> = {
      actorId: interaction.user.id,
      type: 'SET_RESULT_RULED',
      payload: { result: winnerId },
    };
    try {
      const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
      if (match.alertMsgId) {
        const outcome = `awarded the set to ${displayName(players, winnerId)}`;
        const threadLink = `https://discord.com/channels/${match.tournament.guildId}/${match.threadId}`;
        const [ep0, ep1] = match.participants;
        const escalationPlayers: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }] = [
          { entrantId: ep0!.entrantId, name: displayName(players, ep0!.entrantId) },
          { entrantId: ep1!.entrantId, name: displayName(players, ep1!.entrantId) },
        ];
        await alert.resolve(
          match.tournament.guildId,
          { messageId: match.alertMsgId },
          buildResolvedAlert(match.id, cachedPending.songIndex, cachedPending.reason, threadLink, match.tournamentId, escalationPlayers, refDisplayName, outcome),
        );
        await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
      }
      await matchChannel.postLogMessage(ref, renderSetRulingLog(winnerId, refDisplayName, players));
      await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);
      await logToOrganizers(
        alert,
        interaction.guildId!,
        `Set result awarded to **${displayName(players, winnerId)}**, ruling by **${refDisplayName}**\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`,
        { title: '⚖️ Set resolution', color: LOG_COLOR.RULING },
      );
    } catch (err) {
      if (err instanceof IllegalActionError) {
        await interaction.followUp({
          ephemeral: true,
          content: `This action is not available. ${describeStale(err, players)}`,
        });
        return;
      }
      throw err;
    }
    return;
  }

  const songIndex = cachedPending.songIndex!;
  const rulingResult = arg as EntrantId | 'VOID';
  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'SONG_RULED',
    payload: { songIndex, result: rulingResult },
  };

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const chart = result.state.songs[songIndex]!.chart;

    if (match.alertMsgId) {
      const outcome =
        rulingResult === 'VOID' ? 'voided' : `awarded to ${displayName(players, rulingResult)}`;
      const threadLink = `https://discord.com/channels/${match.tournament.guildId}/${match.threadId}`;
      const [ep0, ep1] = match.participants;
      const escalationPlayers: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }] = [
        { entrantId: ep0!.entrantId, name: displayName(players, ep0!.entrantId) },
        { entrantId: ep1!.entrantId, name: displayName(players, ep1!.entrantId) },
      ];
      await alert.resolve(
        match.tournament.guildId,
        { messageId: match.alertMsgId },
        buildResolvedAlert(match.id, cachedPending.songIndex, cachedPending.reason, threadLink, match.tournamentId, escalationPlayers, refDisplayName, outcome),
      );
      await prisma.match.update({ where: { id: match.id }, data: { alertMsgId: null } });
    }

    await matchChannel.postLogMessage(ref, renderRulingLog(songIndex, chart, rulingResult, refDisplayName, players));

    await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);

    const alertOutcome = rulingResult === 'VOID' ? 'voided' : `awarded to **${displayName(players, rulingResult)}**`;
    await logToOrganizers(
      alert,
      interaction.guildId!,
      `Song ${songIndex + 1} (${compactChartLabel(chart)}) ${alertOutcome}, ruling by **${refDisplayName}**\n\n${matchLinksBlock(interaction.guildId!, ref, match.tournamentId)}`,
      { title: '⚖️ Song resolution', color: LOG_COLOR.RULING },
    );
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `This action is not available. ${describeStale(err, players)}`,
      });
      return;
    }
    throw err;
  }
}

const PROTECT_VETO_RESET_REASON = 'Reset by a referee via the match thread button.';

async function handleResetButton(
  interaction: ButtonInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.followUp({ ephemeral: true, content: CANCELLED_MATCH_MESSAGE });
    return;
  }

  const guild = await prisma.guild.findUnique({ where: { id: match.tournament.guildId } });
  const tierConfig: TierRoleConfig = guild ?? { refereeRoleId: null, toRoleId: null, adminRoleId: null };
  if (!hasTier(rolesOfMember(interaction.member), tierConfig, Tier.REFEREE)) {
    await interaction.followUp({ ephemeral: true, content: 'Only a referee can reset Protect/Veto.' });
    return;
  }

  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'PROTECT_VETO_RESET',
    payload: { reason: PROTECT_VETO_RESET_REASON },
  };
  const format = requireFormat(match.formatKey);

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
    await matchChannel.postLogMessage(ref, renderResetLog(refereeDisplayName(interaction)));
    await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `This action is not available. ${describeStale(err, buildPlayerDirectory(match))}`,
      });
      return;
    }
    throw err;
  }
}

async function handleTiebreakPick(
  interaction: StringSelectMenuInteraction,
  decoded: CustomId,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
  alert: AlertPort,
  playerNotification: PlayerNotificationPort,
  realtime: RealtimeBroadcastPort,
): Promise<void> {
  // Ephemeral, never deferUpdate() — see the note at the call site.
  await interaction.deferReply({ ephemeral: true });

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.editReply('This match no longer exists.');
    return;
  }
  if (match.status === 'CANCELLED') {
    await interaction.editReply(CANCELLED_MATCH_MESSAGE);
    return;
  }
  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.editReply("You're not a participant in this match.");
    return;
  }

  const format = requireFormat(match.formatKey);
  const cachedState = match.state as unknown as MatchState;
  const cachedPending = format.pendingAction(cachedState);

  if (cachedPending.kind !== 'TIEBREAK_PICK') {
    // "Selections are final. A second interaction from a player who has
    // already chosen is refused ephemerally, saying what they picked so
    // they are not left guessing." The round may also simply be over.
    const round = cachedState.tiebreaks.at(-1);
    const priorIndex = round?.choices[me.entrantId];
    if (round && priorIndex !== undefined) {
      await interaction.editReply(`Your pick is final. You already chose ${compactChartLabel(round.charts[priorIndex]!)}.`);
    } else {
      await interaction.editReply("That's not available anymore.");
    }
    return;
  }

  const index = Number(interaction.values[0]);
  if (!Number.isInteger(index)) {
    await interaction.editReply('Unrecognized choice.');
    return;
  }

  const event: Omit<MatchEvent, 'seq'> = {
    actorId: interaction.user.id,
    type: 'TIEBREAK_CHOICE',
    payload: { round: cachedPending.round, by: me.entrantId, index },
  };

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    const chosenChart = result.state.tiebreaks.find((t) => t.round === cachedPending.round)!.charts[index]!;
    await interaction.editReply(
      `You picked ${compactChartLabel(chosenChart)}. We'll reveal it once your opponent chooses too.`,
    );
    await applyAppendResult(prisma, matchChannel, alert, playerNotification, realtime, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.editReply("That's not available anymore.");
      return;
    }
    throw err;
  }
}

function buildEvent(
  decoded: CustomId,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  entrantId: string,
  cachedPending: PendingAction,
): Omit<MatchEvent, 'seq'> | null {
  // actorId is the raw Discord user id (see types.ts's Envelope) — distinct
  // from payload.by, which is the EntrantId the reducer actually reasons
  // about. They're never the same value; conflating them would silently
  // lose who-really-clicked once a referee event needs to attribute a
  // ruling to someone who isn't a participant at all.
  const actorId = interaction.user.id;
  switch (decoded.action) {
    case Action.SEED_CHOICE: {
      const arg = decoded.arg;
      if (arg !== 'FIRST' && arg !== 'SECOND') return null;
      return { actorId, type: 'SEED_CHOICE_MADE', payload: { by: entrantId, order: arg } };
    }
    case Action.PROTECT_VETO: {
      if (!interaction.isStringSelectMenu()) return null;
      const drawIndex = Number(interaction.values[0]);
      if (!Number.isInteger(drawIndex)) return null;
      // Reused for a static-pool format's pick (SELECT_SONG) too — see
      // `state-message.ts`'s `renderSelectSong`, which shares this same
      // custom id rather than adding a new Action.
      const type = cachedPending.kind === 'VETO' ? 'CHART_VETOED' : cachedPending.kind === 'SELECT_SONG' ? 'CHART_SELECTED' : 'CHART_PROTECTED';
      return { actorId, type, payload: { by: entrantId, drawIndex } };
    }
    case Action.WINNER: {
      if (cachedPending.kind !== 'SELECT_WINNER') return null;
      const arg = decoded.arg;
      if (!arg) return null;
      const choice = arg as EntrantId | 'TIE';
      return {
        actorId,
        type: 'SONG_WINNER_SELECTED',
        payload: { songIndex: cachedPending.songIndex, by: entrantId, choice },
      };
    }
    case Action.CONFIRM: {
      if (cachedPending.kind !== 'CONFIRM_RESULT') return null;
      const arg = decoded.arg;
      if (!arg) return null;
      return { actorId, type: 'SET_RESULT_CONFIRMED', payload: { by: entrantId, choice: arg as EntrantId } };
    }
    default:
      return null;
  }
}
