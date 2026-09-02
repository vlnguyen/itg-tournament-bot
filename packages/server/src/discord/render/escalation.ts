import { escalationReasonLabel } from '@itg/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId, EscalationReason } from '../../domain/types.js';
import { matchUrl } from '../../web-url.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';
import { LOG_COLOR } from './draw.js';

type EscalationPlayers = readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }];

function escalationTitle(songIndex: number | undefined, reason: EscalationReason): string {
  if (reason === 'TIEBREAK_UNRESOLVED') return 'Match fully tied';
  return songIndex === undefined ? 'Set result disagreement' : reason === 'WINNER_DISAGREEMENT' ? 'Song disagreement' : 'Settings violation reported';
}

/** Shared by the raised alert and its resolution — "identical to the original escalation embed" is the point, so both build from the same description. */
function escalationDescription(
  songIndex: number | undefined,
  threadLink: string,
  tournamentId: string,
  matchId: string,
  players: EscalationPlayers,
): string {
  const header =
    songIndex === undefined
      ? `**${players[0].name}** vs **${players[1].name}**`
      : `Song ${songIndex + 1}: **${players[0].name}** vs **${players[1].name}**`;
  return `${header}\n${threadLink}\n**[Match Link](${matchUrl(tournamentId, matchId)})**`;
}

/**
 * "Award A · Award B · Void song" — three buttons, no tie: a disagreement
 * is always between two different picks, so a ruling either finds one of
 * them correct or voids the song outright. A set-level disagreement
 * (`songIndex` absent) drops the Void button — there is no "void the
 * match" concept here, only naming who actually won.
 *
 * Shared between the alert-channel post and the thread's own escalated
 * state message — the same `Action.RULE` custom_id either way, tier-gated
 * on click rather than on who can see the button, so it's safe to render
 * in both places.
 */
function rulingButtons(
  matchId: string,
  songIndex: number | undefined,
  players: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }],
): ActionRowBuilder<ButtonBuilder> {
  const isSetLevel = songIndex === undefined;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...players.map((p) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ matchId, action: Action.RULE, arg: p.entrantId }))
        .setLabel(`Award ${p.name}`)
        .setStyle(ButtonStyle.Primary),
    ),
    ...(isSetLevel
      ? []
      : [
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ matchId, action: Action.RULE, arg: 'VOID' }))
            .setLabel('Void song')
            .setStyle(ButtonStyle.Danger),
        ]),
  );
}

/**
 * The thread's own state message once escalated. A referee working from
 * inside the thread can rule right here instead of switching to the alert
 * channel — the same buttons, same `Action.RULE` custom_id, still
 * tier-gated on click. Neither player can do anything with them: "no
 * further action from either player until then" still holds, since
 * `handleRulingButton` rejects anyone under Referee tier.
 */
export function buildAwaitingRefereeMessage(
  matchId: string,
  reason: EscalationReason,
  songIndex: number | undefined,
  players: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }],
): RenderedMessage {
  const embed = new EmbedBuilder()
    .setTitle('⚖️ Awaiting referee')
    .setColor(LOG_COLOR.AWAITING_REFEREE)
    .setDescription(`This ${songIndex === undefined ? 'match' : 'song'} is awaiting a referee's ruling on ${escalationReasonLabel(reason)}.`);
  return { embeds: [embed], components: [rulingButtons(matchId, songIndex, players)] };
}

/**
 * Posted to the alert channel. "Escalations mention every distinct role
 * configured at Referee tier or above" — the mention is content built by
 * the caller from `refereeTierRoleIds` (tier.ts), not decided here.
 */
export function buildEscalationAlert(
  matchId: string,
  songIndex: number | undefined,
  reason: EscalationReason,
  refereeMention: string,
  threadLink: string,
  tournamentId: string,
  players: EscalationPlayers,
): RenderedMessage {
  const embed = new EmbedBuilder()
    .setTitle(`⚖️ ${escalationTitle(songIndex, reason)}`)
    .setColor(LOG_COLOR.AWAITING_REFEREE)
    .setDescription(escalationDescription(songIndex, threadLink, tournamentId, matchId, players));

  return { content: refereeMention, embeds: [embed], components: [rulingButtons(matchId, songIndex, players)] };
}

/**
 * Replaces the alert message in place once ruled — identical to the
 * original escalation embed (same title, same description), with a
 * "Resolved by" line appended at the bottom, the referee mention dropped
 * from `content`, and the ruling buttons gone.
 */
export function buildResolvedAlert(
  matchId: string,
  songIndex: number | undefined,
  reason: EscalationReason,
  threadLink: string,
  tournamentId: string,
  players: EscalationPlayers,
  refereeDisplayName: string,
  rulingLabel: string,
): RenderedMessage {
  const embed = new EmbedBuilder()
    .setTitle(`⚖️ ${escalationTitle(songIndex, reason)}`)
    .setColor(LOG_COLOR.AWAITING_REFEREE)
    .setDescription(`${escalationDescription(songIndex, threadLink, tournamentId, matchId, players)}\n\n✅ Resolved by **${refereeDisplayName}**: ${rulingLabel}`);
  return { embeds: [embed] };
}
