import { z } from 'zod';
import { EscalationReason } from './match.js';

/**
 * `GET /api/tournaments/:id/run-view` — the organizer console's run view.
 * See DESIGN.md, "Organizer Alerts and Escalation": "The organizer inbox
 * is therefore a union of two queries" — an escalation is derived
 * (`Match.awaitingTo`, nothing stored that could disagree with the match
 * itself), a threshold alert is a row (`Alert`, for a timer or a
 * departure — conditions with no match state to derive from). Ordered
 * oldest-first by the caller before it ever reaches JSON: "the thing
 * waiting longest is the thing holding up a round."
 */
export const RunViewEscalation = z.object({
  kind: z.literal('ESCALATION'),
  matchId: z.string().min(1),
  matchLabel: z.string(),
  reason: EscalationReason,
  songIndex: z.number().int().nonnegative().optional(),
  since: z.string(),
});
export type RunViewEscalation = z.infer<typeof RunViewEscalation>;

export const RunViewThresholdAlert = z.object({
  kind: z.literal('THRESHOLD'),
  id: z.string().min(1),
  alertKind: z.string(),
  matchId: z.string().nullable(),
  matchLabel: z.string().nullable(),
  payload: z.unknown(),
  since: z.string(),
});
export type RunViewThresholdAlert = z.infer<typeof RunViewThresholdAlert>;

export const RunViewAlert = z.discriminatedUnion('kind', [RunViewEscalation, RunViewThresholdAlert]);
export type RunViewAlert = z.infer<typeof RunViewAlert>;

export const RunViewLiveMatch = z.object({
  matchId: z.string().min(1),
  matchLabel: z.string(),
  participants: z.array(z.object({ entrantId: z.string(), displayName: z.string() })),
  currentChartTitle: z.string().nullable(),
  points: z.record(z.string(), z.number().int()),
  since: z.string(),
});
export type RunViewLiveMatch = z.infer<typeof RunViewLiveMatch>;

export const RunView = z.object({
  alerts: z.array(RunViewAlert),
  liveMatches: z.array(RunViewLiveMatch),
});
export type RunView = z.infer<typeof RunView>;
