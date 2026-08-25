import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { EntrantId, EscalationReason, MatchState, PendingAction } from '../domain/types.js';
import { Action } from './actions.js';
import { encodeCustomId } from './custom-id.js';
import type { RenderedMessage } from './ports.js';
import { buildConfirmResultMessage } from './render/confirm-result.js';
import { fullChartDescription, selectOptionDescription, selectOptionLabel } from './render/chart.js';
import { buildDrawStatusLines } from './render/draw-status.js';
import { buildAwaitingRefereeMessage } from './render/escalation.js';
import { buildScoreTicksLines } from './render/score-ticks.js';
import { buildTiebreakStatusLines } from './render/tiebreak-status.js';
import { buildWinnerSelectMessage } from './render/winner-select.js';

/**
 * `MatchState` addresses players by `EntrantId` (the `Entrant` row's id),
 * never a Discord snowflake directly — rendering a mention needs this
 * lookup. Built by the caller from whatever `Entrant` rows it already
 * queried; nothing here touches Prisma.
 */
export type PlayerDirectory = ReadonlyMap<EntrantId, { discordUserId: string; displayName: string }>;

function mention(players: PlayerDirectory, entrantId: EntrantId): string {
  const p = players.get(entrantId);
  if (!p) throw new Error(`state-message: no player directory entry for entrant ${entrantId}`);
  return `<@${p.discordUserId}>`;
}

/** Non-pinging, for log messages — repeated mentions in a running history would re-notify on every action. */
export function displayName(players: PlayerDirectory, entrantId: EntrantId): string {
  const p = players.get(entrantId);
  if (!p) throw new Error(`state-message: no player directory entry for entrant ${entrantId}`);
  return p.displayName;
}

/**
 * Renders the thread's one live prompt from `pendingAction(state)` — never
 * a second copy of what's legal, only a view of it. `state` supplies what
 * `pending` alone can't (draw contents for a chart index, and so on, as
 * later kinds need it). See DESIGN.md, "The state message shows who has
 * acted, never what."
 */
export function renderStateMessage(
  matchId: string,
  pending: PendingAction,
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  switch (pending.kind) {
    case 'SEED_CHOICE':
      return renderSeedChoice(matchId, pending.actor, players);
    case 'PROTECT':
    case 'VETO':
      return renderProtectVeto(matchId, pending.kind, pending.actor, pending.choices, state, players);
    case 'SUBMIT_SCORE':
      return renderSubmitScore(matchId, pending.songIndex, state, players);
    case 'SELECT_WINNER':
      return renderSelectWinner(matchId, pending.songIndex, state, players);
    case 'AWAITING_TO':
      return renderAwaitingReferee(matchId, pending.reason, pending.songIndex, state, players);
    case 'TIEBREAK_PICK':
      return renderTiebreakPick(matchId, pending.round, pending.choices, state, players);
    case 'CONFIRM_RESULT':
      return renderConfirmResult(matchId, state, players);
    default:
      // Built incrementally alongside the interaction handlers that need
      // each kind — see Phase 4's build order in the plan. A placeholder
      // rather than a throw: the match's own state is correct regardless
      // of what this file can render yet, and live testing outruns the
      // build order.
      return renderNotYetImplemented(pending);
  }
}

function renderNotYetImplemented(pending: PendingAction): RenderedMessage {
  return {
    content: `_Match state is waiting on **${pending.kind}**. Rendering for this step isn't built yet — the underlying state is correct in the database._`,
  };
}

/**
 * "A referee may reset the sequence until song 1 has been played" — legal
 * for exactly the pending kinds this button appears on (`isLegal` enforces
 * the same window independently). One extra row, so it never crowds out
 * the player-facing component above it.
 */
function resetButtonRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.RESET_PV }))
      .setLabel('Reset Protect/Veto (referee)')
      .setStyle(ButtonStyle.Danger),
  );
}

function renderSeedChoice(matchId: string, actorId: EntrantId, players: PlayerDirectory): RenderedMessage {
  const embed = new EmbedBuilder()
    .setTitle('Choose your Protect order')
    .setDescription(
      `${mention(players, actorId)}, you have the higher seed. Looking at the Draw above, do you want to Protect first or second?`,
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.SEED_CHOICE, arg: 'FIRST' }))
      .setLabel('Protect first')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.SEED_CHOICE, arg: 'SECOND' }))
      .setLabel('Protect second')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row, resetButtonRow(matchId)] };
}

function renderProtectVeto(
  matchId: string,
  kind: 'PROTECT' | 'VETO',
  actorId: EntrantId,
  choices: number[],
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  const verb = kind === 'PROTECT' ? 'Protect' : 'Veto';
  const embed = new EmbedBuilder()
    .setTitle(`${verb} a chart`)
    .setDescription(`${mention(players, actorId)}, choose a chart to ${verb.toLowerCase()} from the Draw above.`)
    .addFields({
      name: 'Draw status',
      value: buildDrawStatusLines(state, (id) => displayName(players, id)),
    });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId({ matchId, action: Action.PROTECT_VETO }))
    .setPlaceholder(`Select a chart to ${verb.toLowerCase()}`)
    .addOptions(
      choices.map((i) => {
        const chart = state.draw[i]!;
        const option = new StringSelectMenuOptionBuilder().setLabel(selectOptionLabel(chart)).setValue(String(i));
        const description = selectOptionDescription(chart);
        return description ? option.setDescription(description) : option;
      }),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  return { embeds: [embed], components: [row, resetButtonRow(matchId)] };
}

function renderSubmitScore(
  matchId: string,
  songIndex: number,
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  const song = state.songs[songIndex]!;
  const participantIds = state.participants.map((p) => p.entrantId);

  const embed = new EmbedBuilder()
    .setTitle(`Song ${songIndex + 1}`)
    .setDescription(fullChartDescription(song.chart))
    .addFields({
      name: 'Status',
      value: buildScoreTicksLines(song, participantIds, (id) => displayName(players, id)),
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.SCORE, arg: String(songIndex) }))
      .setLabel('Submit score')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

function renderSelectWinner(
  matchId: string,
  songIndex: number,
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  const song = state.songs[songIndex]!;
  const [a, b] = state.participants;
  return buildWinnerSelectMessage(matchId, songIndex, song, [a!.entrantId, b!.entrantId], (id) =>
    displayName(players, id),
  );
}

function renderConfirmResult(matchId: string, state: MatchState, players: PlayerDirectory): RenderedMessage {
  const [a, b] = state.participants;
  return buildConfirmResultMessage(matchId, state.points, [a!.entrantId, b!.entrantId], (id) =>
    displayName(players, id),
  );
}

function renderAwaitingReferee(
  matchId: string,
  reason: EscalationReason,
  songIndex: number | undefined,
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  const [a, b] = state.participants;
  const named = [a, b].map((p) => ({ entrantId: p!.entrantId, name: displayName(players, p!.entrantId) })) as [
    { entrantId: EntrantId; name: string },
    { entrantId: EntrantId; name: string },
  ];
  return buildAwaitingRefereeMessage(matchId, reason, songIndex, named);
}

/**
 * The select menu lives on this shared message, but a pick must never be
 * answered with `deferUpdate()` — the interaction handler responds
 * ephemerally instead. This message only ever shows *who* has acted,
 * never what — see DESIGN.md, "The tiebreak", and
 * `render/tiebreak-status.ts`.
 */
function renderTiebreakPick(
  matchId: string,
  round: number,
  choices: number[],
  state: MatchState,
  players: PlayerDirectory,
): RenderedMessage {
  const tiebreak = state.tiebreaks.find((t) => t.round === round)!;
  const participantIds = state.participants.map((p) => p.entrantId);

  const embed = new EmbedBuilder()
    .setTitle(`Tiebreak round ${round}`)
    .setDescription(
      'Choose privately. Your pick is not shown to your opponent — or to anyone else — until both of you have chosen, and then it is revealed for both.',
    )
    .addFields({
      name: 'Status',
      value: buildTiebreakStatusLines(tiebreak.choices, participantIds, (id) => displayName(players, id)),
    });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId({ matchId, action: Action.TIEBREAK }))
    .setPlaceholder('Select a chart')
    .addOptions(
      choices.map((i) => {
        const chart = tiebreak.charts[i]!;
        const option = new StringSelectMenuOptionBuilder().setLabel(selectOptionLabel(chart)).setValue(String(i));
        const description = selectOptionDescription(chart);
        return description ? option.setDescription(description) : option;
      }),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  return { embeds: [embed], components: [row] };
}
