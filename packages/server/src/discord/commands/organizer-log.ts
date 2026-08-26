import type { AlertPort } from '../ports.js';

/**
 * Posts a plain informational line to the organizer alert channel. Every
 * tournament lifecycle transition and every roster change posts one of
 * these — not a resolvable escalation like `AlertPort.raise`'s other
 * callers (a disagreement, a settings violation): no ruling buttons,
 * nothing to resolve, just a visible record of who did what. Reuses
 * `AlertPort.raise` because mechanically that's exactly "post to the
 * configured alert channel"; the returned ref is discarded since there's
 * nothing to resolve later.
 */
export async function logToOrganizers(alert: AlertPort, guildId: string, message: string): Promise<void> {
  await alert.raise(guildId, { content: message });
}
