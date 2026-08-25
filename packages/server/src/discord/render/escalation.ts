import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId, EscalationReason } from '../../domain/types.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';

function reasonLabel(reason: EscalationReason): string {
  return reason === 'WINNER_DISAGREEMENT' ? 'a winner disagreement' : 'a reported settings violation';
}

/**
 * The thread's own state message once escalated — "its components are
 * removed, and the thread waits: no retry, no timer." See DESIGN.md,
 * "Scoring a song". No custom_id anywhere here; there is nothing left for
 * either player to legally do until a referee rules.
 */
export function buildAwaitingRefereeMessage(reason: EscalationReason): RenderedMessage {
  return {
    content: `⏸️ This song is awaiting a referee's ruling on ${reasonLabel(reason)}. No further action from either player until then.`,
  };
}

/**
 * Posted to the alert channel. "Escalations mention every distinct role
 * configured at Referee tier or above" — the mention is content built by
 * the caller from `refereeTierRoleIds` (tier.ts), not decided here.
 * "Award A · Award B · Void song" — three buttons, no tie: a disagreement
 * is always between two different picks, so a ruling either finds one of
 * them correct or voids the song outright.
 */
export function buildEscalationAlert(
  matchId: string,
  songIndex: number,
  reason: EscalationReason,
  refereeMention: string,
  threadLink: string,
  players: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }],
): RenderedMessage {
  const title = reason === 'WINNER_DISAGREEMENT' ? 'Song disagreement' : 'Settings violation reported';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`Song ${songIndex + 1} — **${players[0].name}** vs **${players[1].name}**\n${threadLink}`);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...players.map((p) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ matchId, action: Action.RULE, arg: p.entrantId }))
        .setLabel(`Award ${p.name}`)
        .setStyle(ButtonStyle.Primary),
    ),
    new ButtonBuilder()
      .setCustomId(encodeCustomId({ matchId, action: Action.RULE, arg: 'VOID' }))
      .setLabel('Void song')
      .setStyle(ButtonStyle.Danger),
  );

  return { content: refereeMention, embeds: [embed], components: [row] };
}

/** Replaces the alert message in place once ruled — "buttons removed, body replaced with who ruled and what they chose." */
export function buildResolvedAlert(refereeDisplayName: string, rulingLabel: string): RenderedMessage {
  return { content: `✅ Resolved by **${refereeDisplayName}**: ${rulingLabel}` };
}
