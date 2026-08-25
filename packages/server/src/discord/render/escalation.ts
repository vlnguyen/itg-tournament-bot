import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { EntrantId, EscalationReason } from '../../domain/types.js';
import { Action } from '../actions.js';
import { encodeCustomId } from '../custom-id.js';
import type { RenderedMessage } from '../ports.js';

function reasonLabel(reason: EscalationReason): string {
  switch (reason) {
    case 'WINNER_DISAGREEMENT':
      return 'a winner disagreement';
    case 'SETTINGS_VIOLATION':
      return 'a reported settings violation';
    case 'SET_RESULT_DISAGREEMENT':
      return 'a disagreement over who won the set';
  }
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
  return {
    content: `⏸️ This ${songIndex === undefined ? 'match' : 'song'} is awaiting a referee's ruling on ${reasonLabel(reason)}. No further action from either player until then.`,
    components: [rulingButtons(matchId, songIndex, players)],
  };
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
  players: readonly [{ entrantId: EntrantId; name: string }, { entrantId: EntrantId; name: string }],
): RenderedMessage {
  const isSetLevel = songIndex === undefined;
  const title = isSetLevel
    ? 'Set result disagreement'
    : reason === 'WINNER_DISAGREEMENT'
      ? 'Song disagreement'
      : 'Settings violation reported';
  const description = isSetLevel
    ? `**${players[0].name}** vs **${players[1].name}**\n${threadLink}`
    : `Song ${songIndex + 1} — **${players[0].name}** vs **${players[1].name}**\n${threadLink}`;
  const embed = new EmbedBuilder().setTitle(title).setDescription(description);

  return { content: refereeMention, embeds: [embed], components: [rulingButtons(matchId, songIndex, players)] };
}

/** Replaces the alert message in place once ruled — "buttons removed, body replaced with who ruled and what they chose." */
export function buildResolvedAlert(refereeDisplayName: string, rulingLabel: string): RenderedMessage {
  return { content: `✅ Resolved by **${refereeDisplayName}**: ${rulingLabel}` };
}
