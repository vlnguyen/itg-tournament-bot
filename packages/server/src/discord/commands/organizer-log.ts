import { EmbedBuilder } from 'discord.js';
import type { AlertPort, ThreadRef } from '../ports.js';
import { matchUrl } from '../../web-url.js';

/**
 * Posts a plain informational line to the organizer alert channel, as an
 * embed. Every tournament lifecycle transition and every roster change
 * posts one of these — not a resolvable escalation like `AlertPort.raise`'s
 * other callers (a disagreement, a settings violation): no ruling buttons,
 * nothing to resolve, just a visible record of who did what. Reuses
 * `AlertPort.raise` because mechanically that's exactly "post to the
 * configured alert channel"; the returned ref is discarded since there's
 * nothing to resolve later. `message` may carry a markdown link to the
 * tournament's web page — description fields render those, unlike embed
 * titles — so callers hyperlink a tournament name inline rather than
 * appending a bare URL. `opts.title` is for the smaller set of match-scoped
 * notifications (a disqualification, a proactive ruling) that carry their
 * own icon-in-title and accent color, unlike the plain lifecycle/roster
 * lines that leave both unset.
 */
export async function logToOrganizers(
  alert: AlertPort,
  guildId: string,
  message: string,
  opts: { title?: string | undefined; color?: number | undefined } = {},
): Promise<void> {
  const embed = new EmbedBuilder().setDescription(message);
  if (opts.title) embed.setTitle(opts.title);
  if (opts.color !== undefined) embed.setColor(opts.color);
  await alert.raise(guildId, { embeds: [embed] });
}

/**
 * "Match Thread" (a Discord deep link into the thread) and "Match Link"
 * (the public web page) — the two ways an organizer-alert reader, who
 * isn't inside the thread the way an in-thread log's reader already is,
 * can jump into context for a match-scoped notification. The thread link
 * is a bare URL under its own label rather than a masked link — Discord
 * auto-hyperlinks a bare URL in an embed description on its own, and a
 * `discord.com/channels/...` link reads more legibly plain than disguised
 * behind link text.
 */
export function matchLinksBlock(guildId: string, ref: ThreadRef, tournamentId: string): string {
  const threadLink = `https://discord.com/channels/${guildId}/${ref.threadId}`;
  const matchLink = matchUrl(tournamentId, ref.matchId);
  return `**Match Thread**\n${threadLink}\n**[Match Link](${matchLink})**`;
}
