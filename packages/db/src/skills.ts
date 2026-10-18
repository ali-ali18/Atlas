import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { ownerIds } from "./mcp-connections.js";

type Scope = { userId?: string; botId: string };
type Recipe = { capabilityKey: string; [key: string]: unknown };
const LEGACY_OWNER_ID = "default";
function ownerIdOrLegacy(userId: string | undefined): string {
 return userId?.trim() ? userId.trim() : LEGACY_OWNER_ID;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const canonical = (value: unknown): string => {
 if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
 return JSON.stringify(value) ?? "null";
};
async function lock(tx: Prisma.TransactionClient, key: string) {
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
async function scopedVersion(tx: Prisma.TransactionClient, scope: Scope, versionId: string) {
 // Dono no filtro da query: legado ("default") só aparece depois do claim-default.
 const version = await tx.skillVersion.findFirst({ where: { id: versionId, skill: { is: { botId: scope.botId, userId: { in: ownerIds(scope.userId) } } } }, include: { skill: true } });
 if (!version) throw new Error("Skill version not found");
 return version;
}

export async function listBotSkills(userId?: string, botId?: string) {
 return prisma.skill.findMany({ where: { ...(botId ? { botId } : {}), userId: { in: ownerIds(userId) } }, include: { versions: { orderBy: { number: "desc" }, include: { evaluations: { orderBy: { createdAt: "desc" }, take: 1 } } } }, orderBy: { updatedAt: "desc" }, take: 100 });
}
export async function getSkillDetail(userId: string | undefined, botId: string, skillId: string) {
 const skill = await prisma.skill.findFirst({ where: { id: skillId, botId, userId: { in: ownerIds(userId) } }, include: { versions: { orderBy: { number: "desc" }, include: { evidence: true, evaluations: true, usages: { take: 20, orderBy: { createdAt: "desc" } } } } } });
 return skill;
}
export async function createSkillDraft(input: Scope & { recipe: Recipe; sourceRunId?: string; learningJobId?: string }) {
 const ownerId = ownerIdOrLegacy(input.userId);
 return prisma.$transaction(async tx => {
  await lock(tx, `skill:${ownerId}:${input.botId}:${input.recipe.capabilityKey}`);
  if (input.sourceRunId && !await tx.agentRun.findFirst({ where: { id: input.sourceRunId, userId: ownerId, botId: input.botId, status: "completed" } })) throw new Error("Skill evidence run is unavailable or incomplete");
  if (input.learningJobId && !await tx.skillLearningJob.findFirst({ where: { id: input.learningJobId, runId: input.sourceRunId, userId: ownerId, botId: input.botId } })) throw new Error("Invalid learning job evidence");
  const skill = await tx.skill.upsert({ where: { userId_botId_capabilityKey: { userId: ownerId, botId: input.botId, capabilityKey: input.recipe.capabilityKey } }, create: { userId: ownerId, botId: input.botId, capabilityKey: input.recipe.capabilityKey }, update: {} });
  const hash = createHash("sha256").update(canonical(input.recipe)).digest("hex");
  let version = await tx.skillVersion.findUnique({ where: { skillId_hash: { skillId: skill.id, hash } } });
  if (!version) {
   const latest = await tx.skillVersion.findFirst({ where: { skillId: skill.id }, orderBy: { number: "desc" } });
   version = await tx.skillVersion.create({ data: { skillId: skill.id, number: (latest?.number ?? 0) + 1, content: json(input.recipe), hash } });
  }
  if (input.sourceRunId) await tx.skillEvidence.upsert({ where: { versionId_runId: { versionId: version.id, runId: input.sourceRunId } }, create: { versionId: version.id, runId: input.sourceRunId, learningJobId: input.learningJobId }, update: {} });
  return { skill, version };
 });
}

/** Server-owned fixture report. Never expose this mutation directly to model tools. */
export async function recordSkillEvaluation(input: Scope & { versionId: string; passed: boolean; report: unknown; tokens?: number; costUsd?: number }) {
 return prisma.$transaction(async tx => {
  await scopedVersion(tx, input, input.versionId);
  return tx.skillEvaluation.create({ data: { versionId: input.versionId, passed: input.passed, report: json(input.report), tokens: input.tokens ?? 0, costUsd: input.costUsd ?? 0 } });
 });
}
export async function activateSkillVersion(input: Scope & { skillId: string; versionId: string; expectedActiveVersionId: string | null }) {
 return prisma.$transaction(async tx => {
  await lock(tx, `skill-id:${input.skillId}`);
  const version = await scopedVersion(tx, input, input.versionId);
  if (version.skillId !== input.skillId || version.revokedAt) throw new Error("Version cannot be activated");
  const evaluation = await tx.skillEvaluation.findFirst({ where: { versionId: version.id }, orderBy: { createdAt: "desc" } });
  if (!evaluation?.passed) throw new Error("Passing fixture evaluation required");
  const updated = await tx.skill.updateMany({ where: { id: input.skillId, botId: input.botId, activeVersionId: input.expectedActiveVersionId }, data: { activeVersionId: version.id, enabled: true, revision: { increment: 1 } } });
  if (updated.count !== 1) throw new Error("Skill activation conflict");
  await tx.skillVersion.updateMany({ where: { skillId: input.skillId, status: "active", id: { not: version.id } }, data: { status: "retired" } });
  return tx.skillVersion.update({ where: { id: version.id }, data: { status: "active" } });
 });
}
export async function setSkillEnabled(input: Scope & { skillId: string; enabled: boolean }) {
 const existing = await prisma.skill.findFirst({ where: { id: input.skillId, botId: input.botId, userId: { in: ownerIds(input.userId) } }, select: { id: true, userId: true } });
 if (!existing) return { count: 0 };
 return prisma.skill.updateMany({ where: { id: input.skillId, userId: existing.userId }, data: { enabled: input.enabled, revision: { increment: 1 } } });
}
export async function revokeSkillVersion(input: Scope & { versionId: string }) {
 return prisma.$transaction(async tx => {
  const version = await scopedVersion(tx, input, input.versionId);
  await lock(tx, `skill-id:${version.skillId}`);
  await tx.skillVersion.update({ where: { id: version.id }, data: { revokedAt: new Date(), status: "rejected" } });
  await tx.skill.updateMany({ where: { id: version.skillId, activeVersionId: version.id }, data: { activeVersionId: null, revision: { increment: 1 } } });
 });
}
export async function pinSkillUsage(input: Scope & { runId: string; versionId: string }) {
 return prisma.$transaction(async tx => {
  const version = await scopedVersion(tx, input, input.versionId);
  if (!version.skill.enabled || version.revokedAt || version.skill.activeVersionId !== version.id) throw new Error("Skill unavailable");
  if (!await tx.agentRun.findFirst({ where: { id: input.runId, userId: input.userId, botId: input.botId } })) throw new Error("Run unavailable");
  return tx.skillUsage.upsert({ where: { runId_versionId: { runId: input.runId, versionId: input.versionId } }, create: { runId: input.runId, versionId: input.versionId }, update: {} });
 });
}
export async function listRunSkillUsages(runId: string, userId: string, botId: string) {
 return prisma.skillUsage.findMany({ where: { runId, run: { is: { userId, botId } }, version: { is: { skill: { is: { userId, botId } } } } }, include: { version: { include: { skill: true } } } });
}
export async function findSkillByCapability(userId: string, botId: string, capabilityKey: string) {
 return prisma.skill.findUnique({ where: { userId_botId_capabilityKey: { userId, botId, capabilityKey } }, include: { versions: { include: { evidence: true, evaluations: { orderBy: { createdAt: "desc" }, take: 1 } } } } });
}
export async function countSkillEvidencesByCapability(userId: string, botId: string, capabilityKey: string) {
 const skill = await prisma.skill.findUnique({ where: { userId_botId_capabilityKey: { userId, botId, capabilityKey } }, include: { versions: { include: { evidence: { select: { runId: true } } } } } });
 if (!skill) return { skill: null, evidenceRuns: 0 };
 const runs = new Set<string>();
 for (const v of skill.versions) for (const e of v.evidence) runs.add(e.runId);
 return { skill, evidenceRuns: runs.size };
}
/**
 * GC oportunista de utilidade real: desativa skills ativas que provaram ser inúteis.
 * - Falha crônica: >=3 usos com taxa de sucesso <33% (outcomes success vs failed/abandoned).
 * - Nunca usada: ativa há >30 dias e zero usos.
 * Nunca apaga; só `enabled=false` (rollback preservado). Best effort, nunca explode.
 */
export async function deactivateUselessSkills(userId: string, botId: string) {
 const deactivated: string[] = [];
 try {
  const skills = await prisma.skill.findMany({ where: { userId, botId, enabled: true }, include: { versions: { include: { usages: true } } } });
  const now = Date.now();
  for (const skill of skills) {
   if (!skill.activeVersionId) continue;
   const usages = skill.versions.flatMap(v => v.usages);
   if (usages.length >= 3) {
    const ok = usages.filter(u => u.outcome === "success").length;
    if (ok / usages.length < 0.33) {
     await prisma.skill.updateMany({ where: { id: skill.id, userId, botId }, data: { enabled: false, revision: { increment: 1 } } });
     deactivated.push(skill.id);
     continue;
    }
   }
   if (usages.length === 0 && now - new Date(skill.createdAt).getTime() > 30 * 24 * 60 * 60 * 1000) {
    await prisma.skill.updateMany({ where: { id: skill.id, userId, botId }, data: { enabled: false, revision: { increment: 1 } } });
    deactivated.push(skill.id);
   }
  }
 } catch (error) { console.error("deactivateUselessSkills failed", error); }
 return deactivated;
}
export async function recordSkillUsageOutcome(input: Scope & { runId: string; versionId: string; outcome: string; detail?: string }) {
 return prisma.skillUsage.updateMany({ where: { runId: input.runId, versionId: input.versionId, run: { is: { userId: input.userId, botId: input.botId } }, version: { is: { skill: { is: { userId: input.userId, botId: input.botId } } } } }, data: { outcome: input.outcome, detail: input.detail?.slice(0, 1000) } });
}

export async function appendSkillLearningJob(tx: Prisma.TransactionClient, runId: string, extractorVersion = "v1") {
 const run = await tx.agentRun.findUnique({ where: { id: runId } });
 if (!run?.botId || run.status !== "completed" || run.origin === "skill_learning") return null;
 return tx.skillLearningJob.upsert({ where: { runId_extractorVersion: { runId, extractorVersion } }, create: { runId, extractorVersion, userId: run.userId, botId: run.botId }, update: {} });
}

export async function claimSkillLearningJob(input: { owner: string; dailyTokenLimit: number; maxTokensPerAttempt: number; dailyCostLimitUsd?: number; maxCostPerAttemptUsd?: number; dailyCandidateLimit?: number; leaseMs?: number }) {
 if (input.maxTokensPerAttempt <= 0 || !Number.isSafeInteger(input.maxTokensPerAttempt)) throw new Error("Invalid learning budget");
 return prisma.$transaction(async tx => {
  await lock(tx, "skill-learning-consumer");
  const now = new Date();
  // Lost reservations are charged conservatively: a crashed provider call may have cost money.
  await tx.skillLearningJob.updateMany({ where: { status: "running", leaseUntil: { lt: now }, attempts: { gte: 2 } }, data: { status: "failed", error: "Learning lease expired after attempt limit" } });
  const job = await tx.skillLearningJob.findFirst({ where: { OR: [{ status: "pending" }, { status: "running", leaseUntil: { lt: now }, attempts: { lt: 2 } }] }, orderBy: { createdAt: "asc" } });
  if (!job) return null;
  const day = `${job.userId}:${now.toISOString().slice(0, 10)}`;
  const budget = await tx.skillLearningBudget.upsert({ where: { id: day }, create: { id: day }, update: {} });
  const cost = input.maxCostPerAttemptUsd ?? 0;
  if (budget.tokens + input.maxTokensPerAttempt > input.dailyTokenLimit || budget.costUsd + cost > (input.dailyCostLimitUsd ?? Number.MAX_VALUE) || budget.candidates >= (input.dailyCandidateLimit ?? 20)) return null;
  await tx.skillLearningBudget.update({ where: { id: day }, data: { tokens: { increment: input.maxTokensPerAttempt }, costUsd: { increment: cost }, candidates: { increment: 1 } } });
  return tx.skillLearningJob.update({ where: { id: job.id }, data: { status: "running", attempts: { increment: 1 }, tokens: { increment: input.maxTokensPerAttempt }, costUsd: { increment: cost }, reservedTokens: input.maxTokensPerAttempt, reservedCostUsd: cost, budgetDay: day, leaseOwner: input.owner, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + (input.leaseMs ?? 180_000)) } });
 });
}

export async function finishSkillLearningJob(input: { id: string; leaseToken: string; status: "completed" | "skipped" | "failed"; tokens: number; costUsd: number; error?: string }) {
 return prisma.$transaction(async tx => {
  await lock(tx, "skill-learning-consumer");
  const job = await tx.skillLearningJob.findFirst({ where: { id: input.id, status: "running", leaseToken: input.leaseToken, leaseUntil: { gt: new Date() } } });
  if (!job) return false;
  const tokens = Number.isFinite(input.tokens) ? Math.max(0, Math.ceil(input.tokens)) : job.reservedTokens;
  const cost = Number.isFinite(input.costUsd) ? Math.max(0, input.costUsd) : job.reservedCostUsd;
  if (job.budgetDay) await tx.skillLearningBudget.update({ where: { id: job.budgetDay }, data: { tokens: { increment: tokens - job.reservedTokens }, costUsd: { increment: cost - job.reservedCostUsd } } });
  await tx.skillLearningJob.update({ where: { id: job.id }, data: { status: input.status, tokens: { increment: tokens - job.reservedTokens }, costUsd: { increment: cost - job.reservedCostUsd }, reservedTokens: 0, reservedCostUsd: 0, leaseOwner: null, leaseToken: null, leaseUntil: null, error: input.error?.slice(0, 1000) } });
  return true;
 });
}

export async function getSkillLearningSource(userId: string, botId: string, runId: string) {
 return prisma.agentRun.findFirst({ where: { id: runId, userId, botId, status: "completed" }, include: { steps: { orderBy: { index: "asc" }, take: 100 }, artifacts: { take: 20 } } });
}
