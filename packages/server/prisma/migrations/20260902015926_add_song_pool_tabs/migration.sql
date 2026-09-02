-- CreateTable
CREATE TABLE "ChartLabel" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "formatKey" TEXT NOT NULL,
    "chartId" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "ChartLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SongPoolTab" (
    "tournamentId" TEXT NOT NULL,
    "formatKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SongPoolTab_pkey" PRIMARY KEY ("tournamentId","formatKey")
);

-- CreateIndex
CREATE INDEX "ChartLabel_tournamentId_formatKey_idx" ON "ChartLabel"("tournamentId", "formatKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChartLabel_tournamentId_formatKey_chartId_key" ON "ChartLabel"("tournamentId", "formatKey", "chartId");

-- CreateIndex
CREATE UNIQUE INDEX "ChartLabel_tournamentId_formatKey_label_key" ON "ChartLabel"("tournamentId", "formatKey", "label");

-- AddForeignKey
ALTER TABLE "ChartLabel" ADD CONSTRAINT "ChartLabel_chartId_fkey" FOREIGN KEY ("chartId") REFERENCES "Chart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SongPoolTab" ADD CONSTRAINT "SongPoolTab_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;
