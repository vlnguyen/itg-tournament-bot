import { z } from 'zod';

/**
 * `GET /api/tournaments/:id/roster` — DESIGN.md, "Seeding": "The roster is
 * the seeding interface." Every entrant gets a real seed the moment they
 * join and keeps it regardless of check-in status — `checkedIn` is its own
 * column, not a grouping split — so `seed: null` here only ever reflects
 * data that predates that guarantee, not an ordinary state the UI needs to
 * design around.
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

/** `POST /api/tournaments/:id/seeding` body — the whole active roster's order, checked-in or not, submitted as one array either way a reorder was made (drag or typed seed). */
export const SeedingRequest = z.object({ order: z.array(z.string().min(1)).min(1) });
export type SeedingRequest = z.infer<typeof SeedingRequest>;
