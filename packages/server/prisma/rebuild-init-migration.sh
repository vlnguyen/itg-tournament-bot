#!/usr/bin/env bash
# Regenerate the initial migration from schema.prisma and re-attach the
# hand-written constraints in constraints.sql.
#
# Only valid while the initial migration is unreleased — once it has been
# applied anywhere real, schema changes get their own migration instead.
set -euo pipefail
cd "$(dirname "$0")/../../.."
OUT=packages/server/prisma/migrations/00000000000000_init/migration.sql
npx prisma migrate diff --from-empty \
  --to-schema-datamodel packages/server/prisma/schema.prisma --script > "$OUT"
cat packages/server/prisma/constraints.sql >> "$OUT"
echo "rebuilt $OUT"
