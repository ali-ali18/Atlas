// Fase 1 (auth): backfill "default" -> id do dono.
// A migração 20260928010000_auth_foreign_keys já cria a FK User nos campos
// userId (MemoryEntry, AgentRun, Routine, McpConnection, Skill,
// SkillLearningJob, SkillPendingIntent) como NOT VALID — ela vale pra todo
// INSERT/UPDATE novo desde já, mas não escaneia linhas antigas, então pode
// rodar em qualquer deploy sem depender deste script. Depois do backfill
// abaixo (linhas legadas "default" -> id do dono), este script roda
// VALIDATE CONSTRAINT nas 7 tabelas para fechar o ciclo (escaneia as linhas
// já reatribuídas e passa a rejeitar qualquer violação futura na validação
// também, não só em novas escritas). Idempotente: rodar de novo não quebra
// nada (updateMany em cima de linhas já migradas não acha nada; VALIDATE
// CONSTRAINT numa constraint já validada é no-op).
// UserSettings legado tem id="default" (pré-Fase 1; novas linhas usam cuid()).
// F1: lógica extraída para `src/claim-default.ts` (idempotente); o script só
// valida o dono e chama a função. O boot da API chama `maybeClaimDefaultOnBoot`.
import { PrismaClient } from "@prisma/client";

const userId = process.argv.find((arg) => arg.startsWith("--user-id="))?.slice(10);
const ownerEmail = process.env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
if (!userId || !ownerEmail) {
  throw new Error("Usage: ATLAS_OWNER_EMAIL=... pnpm --filter @workspace/db migrate:claim-default --user-id=<authenticated-user-id>");
}

const prisma = new PrismaClient();
try {
  const owner = await prisma.user.findUnique({ where: { id: userId } });
  if (!owner || owner.email.toLowerCase() !== ownerEmail) {
    throw new Error("User does not match ATLAS_OWNER_EMAIL");
  }
  if ((await prisma.user.count()) !== 1) {
    throw new Error("Default data can only be claimed while the owner is the sole user");
  }

  const { claimDefaultAndValidate } = await import("../dist/claim-default.js");
  const result = await claimDefaultAndValidate(userId);
  console.log(JSON.stringify({ claimedFor: result.claimedFor, updated: result.updated }));
} finally {
  await prisma.$disconnect();
}
