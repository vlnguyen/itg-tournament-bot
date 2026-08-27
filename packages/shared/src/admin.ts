import { z } from 'zod';
import { TournamentSummary } from './guild.js';

/**
 * `GET /api/admin/guilds` — DESIGN.md, "Everything else": "Bot
 * administrators get one extra surface: a list of every server the bot is
 * in with its tournaments, and nothing else. It is read-only by
 * construction." Every guild the bot's own Discord client is currently a
 * member of, `tournaments` in every state including `DRAFT` — unlike the
 * public overview and the first-run wizard, there's no non-organizer
 * viewer here to leak an unannounced tournament to: a Bot Administrator is
 * already the most privileged role in the deployment.
 */
export const AdminGuildSummary = z.object({
  guildId: z.string().min(1),
  guildName: z.string(),
  tournaments: z.array(TournamentSummary),
});
export type AdminGuildSummary = z.infer<typeof AdminGuildSummary>;

export const AdminGuildList = z.array(AdminGuildSummary);
export type AdminGuildList = z.infer<typeof AdminGuildList>;
