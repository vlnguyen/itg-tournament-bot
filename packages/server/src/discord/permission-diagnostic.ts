/**
 * Pure permission-resolution logic — no `discord.js` types, so it is
 * unit-testable without a real client. See DESIGN.md, "The diagnostic":
 * "the fix differs depending on where a permission was lost," so the
 * output names the *layer* responsible, not just the missing permission.
 *
 * Mirrors Discord's own resolution order: base (guild-level) permissions,
 * then the `@everyone` channel overwrite, then the union of the member's
 * role-specific overwrites (deny and allow each merged across every role
 * the member holds, allow winning ties within that merge), then an
 * explicit per-member overwrite. `Administrator` short-circuits all of it,
 * exactly as Discord does.
 */

export interface OverwriteLayer {
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
}

const EMPTY_LAYER: OverwriteLayer = { allow: new Set(), deny: new Set() };

export interface PermissionResolutionInput {
  /** Resolved guild-level permissions — the union of every relevant role's own permissions. */
  base: ReadonlySet<string>;
  /** The `@everyone` overwrite on the channel being checked. */
  everyone?: OverwriteLayer;
  /** The union of the checked member's/role's own overwrites on the channel. */
  role?: OverwriteLayer;
  /** An explicit per-member overwrite on the channel, if any. */
  member?: OverwriteLayer;
}

export type PermissionLossLayer = 'ROLE_BASE' | 'EVERYONE_OVERWRITE' | 'ROLE_OVERWRITE' | 'MEMBER_OVERWRITE';

export interface PermissionGap {
  permission: string;
  layer: PermissionLossLayer;
}

const ADMINISTRATOR = 'Administrator';

function isGranted(layer: OverwriteLayer, permission: string): boolean {
  return layer.allow.has(permission);
}
function isDenied(layer: OverwriteLayer, permission: string): boolean {
  return layer.deny.has(permission);
}

/** Whether `permission` is held after resolving every layer, in Discord's own order. */
export function resolvesPermission(input: PermissionResolutionInput, permission: string): boolean {
  if (input.base.has(ADMINISTRATOR)) return true;

  let state = input.base.has(permission);

  const everyone = input.everyone ?? EMPTY_LAYER;
  if (isDenied(everyone, permission)) state = false;
  else if (isGranted(everyone, permission)) state = true;

  const role = input.role ?? EMPTY_LAYER;
  if (isGranted(role, permission)) state = true;
  else if (isDenied(role, permission)) state = false;

  if (input.member) {
    if (isGranted(input.member, permission)) state = true;
    else if (isDenied(input.member, permission)) state = false;
  }

  return state;
}

/**
 * `null` when the permission resolves; otherwise the layer where it was
 * lost, found by replaying the same resolution order and reporting the
 * last layer that left it disallowed. See DESIGN.md's three examples: a
 * role missing it at the server level, a role overwrite denying it despite
 * the role having it, and `@everyone` denying it with no role-level allow.
 */
export function diagnosePermission(input: PermissionResolutionInput, permission: string): PermissionGap | null {
  if (resolvesPermission(input, permission)) return null;

  if (input.member && isDenied(input.member, permission)) {
    return { permission, layer: 'MEMBER_OVERWRITE' };
  }

  const role = input.role ?? EMPTY_LAYER;
  if (isDenied(role, permission) && !isGranted(role, permission)) {
    return { permission, layer: 'ROLE_OVERWRITE' };
  }

  const everyone = input.everyone ?? EMPTY_LAYER;
  if (isDenied(everyone, permission) && !isGranted(everyone, permission)) {
    return { permission, layer: 'EVERYONE_OVERWRITE' };
  }

  return { permission, layer: 'ROLE_BASE' };
}

export function diagnosePermissions(
  input: PermissionResolutionInput,
  required: readonly string[],
): PermissionGap[] {
  return required.map((p) => diagnosePermission(input, p)).filter((g): g is PermissionGap => g !== null);
}

/** Human-readable, naming the concrete fix per DESIGN.md: "send someone to the wrong screen half the time" is exactly what this avoids. */
export function describeGap(gap: PermissionGap, roleLabel: string, channelLabel: string): string {
  switch (gap.layer) {
    case 'ROLE_BASE':
      return `${roleLabel} lacks **${gap.permission}** at the server level. Grant it on the role itself.`;
    case 'EVERYONE_OVERWRITE':
      return `@everyone is denied **${gap.permission}** in ${channelLabel}, and ${roleLabel} has no overwrite granting it. Add an allow overwrite for ${roleLabel} there.`;
    case 'ROLE_OVERWRITE':
      return `${roleLabel} has **${gap.permission}**, but the ${channelLabel} overwrite denies it for that role.`;
    case 'MEMBER_OVERWRITE':
      return `A member-specific overwrite in ${channelLabel} denies **${gap.permission}**.`;
  }
}
