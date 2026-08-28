import { describe, expect, it } from 'vitest';
import {
  describeGap,
  diagnosePermission,
  diagnosePermissions,
  resolvesPermission,
  type PermissionResolutionInput,
} from './permission-diagnostic.js';

const layer = (allow: string[], deny: string[]) => ({ allow: new Set(allow), deny: new Set(deny) });

describe('resolvesPermission', () => {
  it('holds when granted at the base level with no overwrites at all', () => {
    const input: PermissionResolutionInput = { base: new Set(['ViewChannel']) };
    expect(resolvesPermission(input, 'ViewChannel')).toBe(true);
  });

  it('does not hold when absent everywhere', () => {
    const input: PermissionResolutionInput = { base: new Set() };
    expect(resolvesPermission(input, 'ViewChannel')).toBe(false);
  });

  it('Administrator short-circuits every overwrite', () => {
    const input: PermissionResolutionInput = {
      base: new Set(['Administrator']),
      everyone: layer([], ['ViewChannel']),
      role: layer([], ['ViewChannel']),
      member: layer([], ['ViewChannel']),
    };
    expect(resolvesPermission(input, 'ViewChannel')).toBe(true);
  });

  it('an @everyone deny removes a base permission', () => {
    const input: PermissionResolutionInput = {
      base: new Set(['SendMessages']),
      everyone: layer([], ['SendMessages']),
    };
    expect(resolvesPermission(input, 'SendMessages')).toBe(false);
  });

  it('an @everyone allow grants a permission absent from base', () => {
    const input: PermissionResolutionInput = {
      base: new Set(),
      everyone: layer(['ViewChannel'], []),
    };
    expect(resolvesPermission(input, 'ViewChannel')).toBe(true);
  });

  it('a role overwrite deny beats an @everyone allow', () => {
    const input: PermissionResolutionInput = {
      base: new Set(),
      everyone: layer(['ViewChannel'], []),
      role: layer([], ['ViewChannel']),
    };
    expect(resolvesPermission(input, 'ViewChannel')).toBe(false);
  });

  it('a role overwrite allow beats a role-base absence and an @everyone deny', () => {
    const input: PermissionResolutionInput = {
      base: new Set(),
      everyone: layer([], ['ManageThreads']),
      role: layer(['ManageThreads'], []),
    };
    expect(resolvesPermission(input, 'ManageThreads')).toBe(true);
  });

  it('a member overwrite deny beats a role overwrite allow', () => {
    const input: PermissionResolutionInput = {
      base: new Set(['SendMessages']),
      role: layer(['SendMessages'], []),
      member: layer([], ['SendMessages']),
    };
    expect(resolvesPermission(input, 'SendMessages')).toBe(false);
  });
});

describe('diagnosePermission', () => {
  it('is null when the permission resolves', () => {
    const input: PermissionResolutionInput = { base: new Set(['ViewChannel']) };
    expect(diagnosePermission(input, 'ViewChannel')).toBeNull();
  });

  it('names ROLE_BASE when nothing at any layer grants it — DESIGN.md\'s first example', () => {
    const input: PermissionResolutionInput = { base: new Set() };
    expect(diagnosePermission(input, 'ManageThreads')).toEqual({ permission: 'ManageThreads', layer: 'ROLE_BASE' });
  });

  it('names ROLE_OVERWRITE when the role has it at base but a channel overwrite denies it — the second example', () => {
    const input: PermissionResolutionInput = {
      base: new Set(['ManageThreads']),
      role: layer([], ['ManageThreads']),
    };
    expect(diagnosePermission(input, 'ManageThreads')).toEqual({ permission: 'ManageThreads', layer: 'ROLE_OVERWRITE' });
  });

  it('names EVERYONE_OVERWRITE when @everyone denies it and the role has no explicit allow — the third example', () => {
    const input: PermissionResolutionInput = {
      base: new Set(),
      everyone: layer([], ['ViewChannel']),
    };
    expect(diagnosePermission(input, 'ViewChannel')).toEqual({ permission: 'ViewChannel', layer: 'EVERYONE_OVERWRITE' });
  });

  it('names MEMBER_OVERWRITE when an explicit member deny is what finally loses it', () => {
    const input: PermissionResolutionInput = {
      base: new Set(['SendMessages']),
      role: layer(['SendMessages'], []),
      member: layer([], ['SendMessages']),
    };
    expect(diagnosePermission(input, 'SendMessages')).toEqual({ permission: 'SendMessages', layer: 'MEMBER_OVERWRITE' });
  });

  it('attributes to EVERYONE_OVERWRITE, not ROLE_BASE, when the role layer never touched the permission', () => {
    // Base lacks it too, but @everyone is the layer that's actually denying —
    // it should be named even though the role never had it either.
    const input: PermissionResolutionInput = {
      base: new Set(),
      everyone: layer([], ['CreatePrivateThreads']),
      role: layer([], []),
    };
    expect(diagnosePermission(input, 'CreatePrivateThreads')).toEqual({
      permission: 'CreatePrivateThreads',
      layer: 'EVERYONE_OVERWRITE',
    });
  });
});

describe('diagnosePermissions', () => {
  it('reports only the permissions that are actually missing, in the required order', () => {
    const input: PermissionResolutionInput = { base: new Set(['ViewChannel']) };
    const gaps = diagnosePermissions(input, ['ViewChannel', 'SendMessages', 'ManageThreads']);
    expect(gaps.map((g) => g.permission)).toEqual(['SendMessages', 'ManageThreads']);
  });

  it('is empty when everything required resolves', () => {
    const input: PermissionResolutionInput = { base: new Set(['ViewChannel', 'SendMessages']) };
    expect(diagnosePermissions(input, ['ViewChannel', 'SendMessages'])).toEqual([]);
  });
});

describe('describeGap', () => {
  it('names the role and the fix for each layer', () => {
    expect(describeGap({ permission: 'ManageThreads', layer: 'ROLE_BASE' }, 'Referee', '#matches')).toContain(
      'Grant it on the role',
    );
    expect(describeGap({ permission: 'ManageThreads', layer: 'ROLE_OVERWRITE' }, 'Referee', '#matches')).toContain(
      '#matches overwrite denies it',
    );
    expect(describeGap({ permission: 'ViewChannel', layer: 'EVERYONE_OVERWRITE' }, 'Referee', '#matches')).toContain(
      'Add an allow overwrite for Referee',
    );
    expect(describeGap({ permission: 'SendMessages', layer: 'MEMBER_OVERWRITE' }, 'Referee', '#matches')).toContain(
      'member-specific overwrite',
    );
  });
});
