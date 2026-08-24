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
import type { MatchEvent, MatchFormat, MatchState, PendingAction } from '../domain/types.js';
import { requireFormat } from '../services/engine.js';
import { appendMatchEvent, IllegalActionError, type AppendResult } from '../services/match-service.js';
import type { RandomPort } from '../services/ports.js';
import { Action, SCORE_MODAL_EX_FIELD } from './actions.js';
import { decodeCustomId, encodeCustomId, type CustomId } from './custom-id.js';
import { renderProtectVetoLog, renderSeedChoiceLog } from './log-messages.js';
import { buildPlayerDirectory, loadMatch, type MatchWithParticipants } from './match-lookup.js';
import type { MatchChannelPort, RenderedMessage, ThreadRef } from './ports.js';
import { buildMatchSongsEmbed } from './render/match-songs.js';
import { parseExPercent } from './validate-ex.js';
import { displayName, renderStateMessage, type PlayerDirectory } from './state-message.js';

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
): void {
  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    handle(interaction, prisma, random, matchChannel).catch((err: unknown) => {
      console.error('[discord] interaction handler failed', err);
    });
  });
}

async function handle(
  interaction: Interaction,
  prisma: PrismaClient,
  random: RandomPort,
  matchChannel: MatchChannelPort,
): Promise<void> {
  if (interaction.isModalSubmit()) {
    const decoded = decodeCustomId(interaction.customId);
    if (!decoded || decoded.action !== Action.SCORE) return;
    await handleScoreModalSubmit(interaction, decoded, prisma, random, matchChannel);
    return;
  }

  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const decoded = decodeCustomId(interaction.customId);
  if (!decoded) return; // not one of ours

  if (interaction.isButton() && decoded.action === Action.SCORE) {
    await interaction.showModal(buildScoreModal(decoded));
    return;
  }

  await interaction.deferUpdate();

  const match = await loadMatch(prisma, decoded.matchId);
  if (!match) {
    await interaction.followUp({ ephemeral: true, content: 'This match no longer exists.' });
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
    await applyAppendResult(matchChannel, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
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
  const me = match.participants.find((p) => p.entrant.discordUserId === interaction.user.id);
  if (!me) {
    await interaction.followUp({ ephemeral: true, content: "You're not a participant in this match." });
    return;
  }

  const songIndex = Number(decoded.arg);
  const event: Omit<MatchEvent, 'seq'> = {
    actorId: me.entrantId,
    type: 'SCORE_SUBMITTED',
    payload: { songIndex, by: me.entrantId, ex },
  };
  const format = requireFormat(match.formatKey);

  try {
    const result = await appendMatchEvent(prisma, random, match.id, event, interaction.id);
    await applyAppendResult(matchChannel, match, format, event, result);
  } catch (err) {
    if (err instanceof IllegalActionError) {
      await interaction.followUp({
        ephemeral: true,
        content: `That's not available anymore — ${describeStale(err)}.`,
      });
      return;
    }
    throw err;
  }
}

/**
 * Everything that happens after a successful append, shared by every
 * action type: a permanent log line where one applies, the Protect/Veto
 * completion recap where that transition just happened, and the state
 * message re-rendered from whatever is now pending.
 */
async function applyAppendResult(
  matchChannel: MatchChannelPort,
  match: MatchWithParticipants,
  format: MatchFormat,
  event: Omit<MatchEvent, 'seq'>,
  result: AppendResult,
): Promise<void> {
  const players = buildPlayerDirectory(match);
  const ref: ThreadRef = { matchId: match.id, threadId: match.threadId! };
  const before = match.state as unknown as MatchState;

  // A permanent record of the action itself — the state message's own
  // draw-status field is disposable and will move on to a different
  // prompt, but the sequence of picks should survive in the thread's
  // history regardless. See DESIGN.md, "Two kinds of bot message."
  const log = renderActionLog(event, result.state, players);
  if (log) await matchChannel.postLogMessage(ref, log);

  // Protect/Veto just finished — ABBAAB's sixth and last action always
  // lands on exactly 4 protects and 2 vetoes. Checked as a *transition*
  // (not complete before, complete after): that count never changes again
  // once reached, so a bare state check would re-fire this on every action
  // for the rest of the match.
  const justCompleted = (s: MatchState) => s.protects.length === 4 && s.vetoes.length === 2;
  if (!justCompleted(before) && justCompleted(result.state)) {
    const songs = buildMatchSongsEmbed(result.state, (id) => displayName(players, id));
    await matchChannel.postLogMessage(ref, { embeds: [songs] });
  }

  const pending = format.pendingAction(result.state);
  await matchChannel.postMatchState(ref, renderStateMessage(match.id, pending, result.state, players));
}

function renderActionLog(
  eventInput: Omit<MatchEvent, 'seq'>,
  after: MatchState,
  players: PlayerDirectory,
): RenderedMessage | null {
  // `Omit<MatchEvent, 'seq'>` doesn't narrow on `.type` the way `MatchEvent`
  // itself does — a known TS gap with `Omit` over a discriminated union of
  // intersections. The `seq` is irrelevant to rendering, so a throwaway
  // value restores the discriminated-union shape for the switch below.
  const event = { ...eventInput, seq: 0 } as MatchEvent;
  switch (event.type) {
    case 'SEED_CHOICE_MADE':
      return renderSeedChoiceLog(event.payload.by, event.payload.order, players);
    case 'CHART_PROTECTED':
      return renderProtectVetoLog('PROTECT', event.payload.by, after.draw[event.payload.drawIndex]!, players);
    case 'CHART_VETOED':
      return renderProtectVetoLog('VETO', event.payload.by, after.draw[event.payload.drawIndex]!, players);
    default:
      return null;
  }
}

function describeStale(err: IllegalActionError): string {
  if (err.pending.kind === 'DONE') return 'the match is already decided';
  return `it's currently waiting on ${err.pending.kind.toLowerCase().replaceAll('_', ' ')}`;
}

function buildEvent(
  decoded: CustomId,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  entrantId: string,
  cachedPending: PendingAction,
): Omit<MatchEvent, 'seq'> | null {
  switch (decoded.action) {
    case Action.SEED_CHOICE: {
      const arg = decoded.arg;
      if (arg !== 'FIRST' && arg !== 'SECOND') return null;
      return { actorId: entrantId, type: 'SEED_CHOICE_MADE', payload: { by: entrantId, order: arg } };
    }
    case Action.PROTECT_VETO: {
      if (!interaction.isStringSelectMenu()) return null;
      const drawIndex = Number(interaction.values[0]);
      if (!Number.isInteger(drawIndex)) return null;
      const type = cachedPending.kind === 'VETO' ? 'CHART_VETOED' : 'CHART_PROTECTED';
      return { actorId: entrantId, type, payload: { by: entrantId, drawIndex } };
    }
    default:
      return null;
  }
}
