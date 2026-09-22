-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "forceUsername" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packUrl" TEXT,
ADD COLUMN     "requirePhotos" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rules" TEXT,
ADD COLUMN     "statusMsgId" TEXT;
