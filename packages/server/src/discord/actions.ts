/**
 * The `action` segment of every `custom_id` this bot creates — named here
 * once so `state-message.ts` (encoding) and `interactions.ts` (decoding)
 * can't drift apart on what a string like `"SEED"` means.
 */
export const Action = {
  SEED_CHOICE: 'SEED',
  PROTECT_VETO: 'PV',
} as const;

export type Action = (typeof Action)[keyof typeof Action];
