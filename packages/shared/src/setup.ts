import { z } from 'zod';

/**
 * The web console's server-reconfiguration panel — DESIGN.md's "server
 * reconfiguration (Manage Guild gated, not tier)," the last piece of the
 * organizer console. Mirrors `/setup` exactly: point-at-existing or
 * create-for-me for four channel slots and two tier roles, a live
 * permission diagnostic, and a repair action — one implementation
 * (`discord/setup-effects.ts`, server-side) behind both surfaces.
 */

export const ChannelSlot = z.enum(['matches', 'alerts', 'results', 'general']);
export type ChannelSlot = z.infer<typeof ChannelSlot>;

export const TierRoleSlot = z.enum(['referee', 'organizer']);
export type TierRoleSlot = z.infer<typeof TierRoleSlot>;

/** One entry for a `<select>` of the guild's own channels/roles — id to submit, name to show. */
export const GuildOption = z.object({ id: z.string().min(1), name: z.string() });
export type GuildOption = z.infer<typeof GuildOption>;

export const SetupBindings = z.object({
  matches: z.string().nullable(),
  alerts: z.string().nullable(),
  results: z.string().nullable(),
  general: z.string().nullable(),
  referee: z.string().nullable(),
  organizer: z.string().nullable(),
});
export type SetupBindings = z.infer<typeof SetupBindings>;

/**
 * `gapDescriptions` are already-rendered sentences, not structured gap
 * data — the server resolves each gap's channel/role into a plain-text
 * label (`describeGap`, `discord/permission-diagnostic.ts`) the same way
 * it resolves a Discord mention for the embed, just in plain English
 * instead. One rendering, reused, rather than a second client-side
 * formatter that could drift from the Discord one's wording.
 */
export const SetupDiagnostic = z.object({
  gapDescriptions: z.array(z.string()),
  missingChannels: z.array(ChannelSlot),
  missingTierRoles: z.array(TierRoleSlot),
  deletedTierRoles: z.array(TierRoleSlot),
  refereePoolEmpty: z.boolean(),
  repairableCount: z.number().int().nonnegative(),
});
export type SetupDiagnostic = z.infer<typeof SetupDiagnostic>;

/**
 * `GET /api/guilds/:guildId/setup` — everything the panel needs in one
 * fetch: current bindings, the diagnostic, and what's pickable for each
 * slot. `notes` is empty on a plain `GET`; a `POST` that changed something
 * (pointed at a channel, created one, repaired an overwrite) returns the
 * same shape with a line per change, mirroring the preface `/setup`'s own
 * ephemeral reply shows above its diagnostic.
 */
export const SetupStatus = z.object({
  bindings: SetupBindings,
  diagnostic: SetupDiagnostic,
  channels: z.array(GuildOption),
  roles: z.array(GuildOption),
  notes: z.array(z.string()).default([]),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * A slot's value in the request body is a channel/role id to point at, or
 * the literal `'CREATE'` to create a new one — an explicit action, never
 * implied by leaving a field blank. A slot's key absent from the body at
 * all is a strict no-op: it is left exactly as already configured, and
 * nothing is created just because nothing was said about it. This is
 * deliberately *not* `/setup channels`/`/setup roles`' own bootstrap
 * default (bare invocation creates everything missing) — that default is
 * synthesized in the Discord command layer, not here; the console never
 * creates anything a person didn't explicitly ask for.
 */
const Pick = z.union([z.string().min(1), z.literal('CREATE')]);

/** `POST /api/guilds/:guildId/setup/channels` body. `general` has no `'CREATE'` — it is only ever pointed at. */
export const SetupChannelsRequest = z.object({
  matches: Pick.optional(),
  alerts: Pick.optional(),
  results: Pick.optional(),
  general: z.string().min(1).optional(),
});
export type SetupChannelsRequest = z.infer<typeof SetupChannelsRequest>;

/** `POST /api/guilds/:guildId/setup/roles` body — same rules as `SetupChannelsRequest`. */
export const SetupRolesRequest = z.object({
  referee: Pick.optional(),
  organizer: Pick.optional(),
});
export type SetupRolesRequest = z.infer<typeof SetupRolesRequest>;
