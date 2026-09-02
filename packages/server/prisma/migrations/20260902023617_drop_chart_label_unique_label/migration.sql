-- DropIndex
DROP INDEX "ChartLabel_tournamentId_formatKey_idx";

-- DropIndex
DROP INDEX "ChartLabel_tournamentId_formatKey_label_key";

-- CreateIndex
CREATE INDEX "ChartLabel_tournamentId_formatKey_label_idx" ON "ChartLabel"("tournamentId", "formatKey", "label");
