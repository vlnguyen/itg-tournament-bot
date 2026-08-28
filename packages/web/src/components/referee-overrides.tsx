import type { EntrantId, PublicMatch, RulingRequest } from '@itg/shared';
import { Alert, Button, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, submitRuling } from '../lib/api.js';

/**
 * DESIGN.md, "Match detail": "Every override lives here." Shown to any
 * signed-in user, same as `PackImport` — authorization is enforced by the
 * `POST /api/matches/:id/rulings` call itself (Referee tier), not by a
 * client-side gate that would just be theater. A user without tier sees
 * the resulting error rather than a hidden section.
 *
 * Not a full replica of the freeze predicate: controls are shown whenever
 * plausible (an active song exists, the match isn't decided) and the
 * server's own `IllegalActionError` message explains a rejection, same as
 * a Discord ruling button would fail with "already resolved."
 */
export function RefereeOverrides({ matchId, pub }: { matchId: string; pub: PublicMatch }): JSX.Element | null {
  const queryClient = useQueryClient();
  const [resetReason, setResetReason] = useState('');
  const [dqTarget, setDqTarget] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (ruling: RulingRequest) => submitRuling(matchId, ruling),
    onSuccess: (updated) => {
      queryClient.setQueryData(['match', matchId], updated);
    },
  });

  const [p0, p1] = pub.participants;
  if (!p0 || !p1) return null; // nobody seated yet — nothing to rule on

  const decided = pub.outcome !== null;
  // Nothing frozen-but-visible: a decided match has no legal override left,
  // per DESIGN.md's "absent, not disabled but present."
  if (decided) return null;

  const activeSong = pub.songs.find((s) => !s.result);
  const rule = (ruling: RulingRequest): void => mutation.mutate(ruling);

  const errorMessage = mutation.isError ? (mutation.error instanceof ApiError ? mutation.error.message : 'Something went wrong.') : null;

  return (
    <Stack gap="sm">
      <Title order={2} size="h4">
        Referee Overrides
      </Title>

      {errorMessage && (
        <Alert color="red" title="Ruling failed">
          {errorMessage}
        </Alert>
      )}

      {activeSong && (
        <div>
          <Text size="sm" fw={600}>
            Song {activeSong.index + 1}: {activeSong.chart.title}
          </Text>
          <Group gap="xs" mt={4}>
            <Button size="xs" onClick={() => rule({ type: 'SONG_RULED', songIndex: activeSong.index, result: p0.entrantId })}>
              Award {p0.displayName}
            </Button>
            <Button size="xs" onClick={() => rule({ type: 'SONG_RULED', songIndex: activeSong.index, result: p1.entrantId })}>
              Award {p1.displayName}
            </Button>
            <Button size="xs" color="red" variant="outline" onClick={() => rule({ type: 'SONG_RULED', songIndex: activeSong.index, result: 'VOID' })}>
              Void song
            </Button>
          </Group>
        </div>
      )}

      {!decided && (
        <div>
          <Text size="sm" fw={600}>
            Reset the current Protect/Veto
          </Text>
          <Group gap="xs" mt={4}>
            <TextInput
              placeholder="Reason (e.g. flagged chart)"
              size="xs"
              value={resetReason}
              onChange={(e) => setResetReason(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={resetReason.trim().length === 0}
              onClick={() => {
                rule({ type: 'PROTECT_VETO_RESET', reason: resetReason.trim() });
                setResetReason('');
              }}
            >
              Reset
            </Button>
          </Group>
        </div>
      )}

      {!decided && (
        <div>
          <Text size="sm" fw={600}>
            Award the set
          </Text>
          <Group gap="xs" mt={4}>
            <Button
              size="xs"
              color="orange"
              variant="outline"
              onClick={() => {
                if (confirm(`Award the whole set to ${p0.displayName}? This ends the match.`)) rule({ type: 'SET_RESULT_RULED', result: p0.entrantId });
              }}
            >
              Award set to {p0.displayName}
            </Button>
            <Button
              size="xs"
              color="orange"
              variant="outline"
              onClick={() => {
                if (confirm(`Award the whole set to ${p1.displayName}? This ends the match.`)) rule({ type: 'SET_RESULT_RULED', result: p1.entrantId });
              }}
            >
              Award set to {p1.displayName}
            </Button>
          </Group>
        </div>
      )}

      {!decided && (
        <div>
          <Text size="sm" fw={600}>
            Disqualify from this match
          </Text>
          <Group gap="xs" mt={4}>
            <Select
              size="xs"
              placeholder="Player"
              data={[p0, p1].map((p) => ({ value: p.entrantId, label: p.displayName }))}
              value={dqTarget}
              onChange={setDqTarget}
            />
            <Button
              size="xs"
              color="red"
              disabled={!dqTarget}
              onClick={() => {
                if (!dqTarget) return;
                const name = [p0, p1].find((p) => p.entrantId === dqTarget)?.displayName ?? dqTarget;
                if (confirm(`Disqualify ${name} from this match?`)) rule({ type: 'DQ_APPLIED', playerId: dqTarget as EntrantId });
              }}
            >
              Disqualify
            </Button>
          </Group>
        </div>
      )}
    </Stack>
  );
}
