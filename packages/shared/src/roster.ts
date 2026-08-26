import { z } from 'zod';

/**
 * `GET /api/tournaments/:id/roster` — DESIGN.md, "Seeding": "The roster is
 * the seeding interface." `seed: null` is exactly the not-checked-in group
 * DESIGN.md calls out — "unseeded entrants sit in a separate group... in
 * join order" — so the client splits on that rather than the server
 * shipping two separate arrays.
 */
export const RosterEntrant = z.object({
  entrantId: z.string().min(1),
  discordUserId: z.string().min(1),
  displayName: z.string().nullable(),
  checkedIn: z.boolean(),
  seed: z.number().int().positive().nullable(),
  joinedAt: z.string(),
});
export type RosterEntrant = z.infer<typeof RosterEntrant>;

export const Roster = z.array(RosterEntrant);
export type Roster = z.infer<typeof Roster>;

/** `POST /api/tournaments/:id/seeding` body — the whole checked-in order, submitted as one array either way a reorder was made (drag or typed seed). */
export const SeedingRequest = z.object({ order: z.array(z.string().min(1)).min(1) });
export type SeedingRequest = z.infer<typeof SeedingRequest>;
