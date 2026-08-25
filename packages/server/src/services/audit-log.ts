import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * `AuditLog` is deliberately generic — `targetType`/`targetId` name whatever
 * the action was about (`Guild`, `Tournament`, `Entrant`, `Match`) rather
 * than a column per kind. Written from `/setup`, tournament lifecycle
 * transitions, on-behalf `/roster` actions, and `/dq`/`/forfeit` — every
 * write this phase makes has a real Discord actor, so `actorUserId` is
 * never a bot placeholder here.
 */
export async function logAction(
  db: PrismaClient | Prisma.TransactionClient,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  payload: Prisma.InputJsonValue = {},
): Promise<void> {
  await db.auditLog.create({ data: { actorUserId, action, targetType, targetId, payload } });
}
