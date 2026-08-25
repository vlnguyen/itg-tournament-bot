import type { ActionRowBuilder, EmbedBuilder, MessageActionRowComponentBuilder } from 'discord.js';

/**
 * "Everything the domain needs from a chat platform" — see DESIGN.md,
 * "Ports and Adapters". A payload is `discord.js`'s own builder types
 * rather than a reinvented shape: the boundary that matters is
 * `services/`/`domain/` never importing `discord.js` at all, which they
 * don't — nothing here is imported by either. Inside this module,
 * `necord` vs. `discord.js` was already the only choice left "load-bearing
 * enough to matter," so there's no separate payoff to a second translation
 * layer between a rendered message and the Discord API call that sends it.
 *
 * `PrivatePromptPort` from the design sketch is deliberately absent. The
 * one place a truly private prompt exists — the tiebreak pick — is always
 * an ephemeral *reply* to the interaction the player just opened, never a
 * message pushed to them out of the blue; there's nothing to abstract
 * beyond `interaction.reply({ ephemeral: true, ... })`, called directly
 * where that interaction is already in hand.
 */

export interface ThreadRef {
  matchId: string;
  threadId: string;
}

export interface RenderedMessage {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

export interface MatchChannelPort {
  /**
   * No `playerIds` here — a private thread's competitors join it as a side
   * effect of `PlayerNotificationPort.matchReady`'s mention, not an
   * explicit membership call. Mentioning a user in a thread message adds
   * them to it if they can see the parent channel, which both competitors
   * always can (matches channel view is granted to `@everyone`); a
   * separate `thread.members.add` per player is redundant with that.
   */
  createMatchThread(input: { matchId: string; title: string }): Promise<ThreadRef>;
  /** Permanent: the Draw, a committed song result, a tiebreak reveal, a ruling, a reset note. Never edited or deleted. */
  postLogMessage(thread: ThreadRef, message: RenderedMessage): Promise<void>;
  /** The singular, disposable prompt. Edited in place when it is still the last message; deleted and reposted otherwise. */
  postMatchState(thread: ThreadRef, message: RenderedMessage): Promise<void>;
  archiveThread(thread: ThreadRef): Promise<void>;
  /** One public line per finished match, outside any thread. `ref.matchId` is how the adapter resolves the guild's configured results channel. */
  publishResult(thread: ThreadRef, message: RenderedMessage): Promise<void>;
}

/** "Tell these players their match is ready" — the adapter decides how (thread mention, best-effort DM, or both). */
export interface PlayerNotificationPort {
  matchReady(playerIds: string[], thread: ThreadRef): Promise<void>;
  /**
   * "The bot announces when check-in opens, in the general channel, and
   * direct messages every registered player. The channel post carries no
   * mentions." See REQUIREMENTS.md, "Notifications". The channel post is
   * skipped (not an error) when no general channel is configured, same as
   * every other use of that optional forward target. Returns the player ids
   * the DM could not reach, best-effort — same failure semantics as
   * `matchReady` — so the caller can surface who to chase.
   */
  checkinOpened(guildId: string, playerIds: string[]): Promise<{ unreachable: string[] }>;
  /**
   * A public, no-mentions announcement in the general channel that `/join`
   * is now open — there is no one registered yet to DM, unlike
   * `checkinOpened`. Skipped (not an error) when no general channel is
   * configured.
   */
  registrationOpened(guildId: string, tournamentName: string): Promise<void>;
  /**
   * A public, no-mentions announcement in the general channel each time
   * someone joins — names who, and reminds anyone reading how to join
   * themselves. Skipped (not an error) when no general channel is
   * configured.
   */
  entrantJoined(guildId: string, displayName: string): Promise<void>;
  /** Same idea as `entrantJoined`, for a self-service check-in. */
  entrantCheckedIn(guildId: string, displayName: string): Promise<void>;
  /** A public, no-mentions announcement in the general channel that a tournament was cancelled. Skipped (not an error) when no general channel is configured. */
  tournamentCancelled(guildId: string, tournamentName: string): Promise<void>;
  /** A public, no-mentions announcement in the general channel that check-in has closed. Skipped (not an error) when no general channel is configured. */
  checkinClosed(guildId: string, tournamentName: string): Promise<void>;
  /** A public, no-mentions announcement in the general channel that the tournament has started. Skipped (not an error) when no general channel is configured. */
  tournamentStarted(guildId: string, tournamentName: string): Promise<void>;
}

export interface AlertRef {
  messageId: string;
}

/** Organizer-facing alerts: a disagreement or settings-violation escalation, posted with ruling buttons and resolved by editing in place. */
export interface AlertPort {
  raise(guildId: string, message: RenderedMessage): Promise<AlertRef>;
  resolve(guildId: string, ref: AlertRef, resolution: RenderedMessage): Promise<void>;
}
