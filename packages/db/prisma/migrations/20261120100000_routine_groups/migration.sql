-- Grupos de rotinas: agrupa rotinas que servem a uma mesma tarefa (por bot).
CREATE TABLE "routine_groups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routine_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "routine_groups_botId_idx" ON "routine_groups"("botId");

ALTER TABLE "routine_groups" ADD CONSTRAINT "routine_groups_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "routines" ADD COLUMN "groupId" TEXT;

CREATE INDEX "routines_groupId_idx" ON "routines"("groupId");

ALTER TABLE "routines" ADD CONSTRAINT "routines_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "routine_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
