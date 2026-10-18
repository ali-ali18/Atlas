import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

/**
 * Backfill "default" → id do dono (F1). Extração idempotente de
 * `packages/db/scripts/claim-default.mjs`: reatribui as linhas legadas
 * (`userId="default"`, `ownerId=null`, `userId=null`) ao dono e valida as 7
 * FKs NOT VALID da migração `20260928010000_auth_foreign_keys`.
 *
 * Idempotente: rodar de novo não muda nada (updateMany em cima de linhas já
 * migradas não acha nada; VALIDATE CONSTRAINT já validada é no-op).
 *
 * Colisões de unique (F1-ajuste): o dono pode já ter linha própria criada
 * depois (ex.: reconectou o GitHub e a linha legada foi reivindicada, mas
 * outra `"default"` do mesmo catálogo ficou para trás). Sem tratar, o
 * `updateMany` estoura `@@unique` e a transação inteira falha em todo boot:
 * - `mcp_connections(userId,catalogId)`: a `"default"` duplicada é APAGADA
 *   (a própria ganha — mesma regra de `resolveMcpConnection`);
 * - `mcp_connections(userId,slug)`: as `"default"` restantes com slug
 *   colidido são renomeadas (`<slug>_2`…);
 * - `skills(userId,botId,capabilityKey)`: as `"default"` que colidem são
 *   reivindicadas com `capabilityKey` renomeada (`<key>_legado`,
 *   `_legado_2`…) e `enabled=false` — nada é perdido, nenhuma linha fica
 *   `"default"` (a FK `skills_userId_fkey` valida) e mesclar versões de
 *   skill automaticamente seria destrutivo. `capabilityKey` só existe como
 *   coluna de `skills` (nenhuma outra tabela referencia por valor; versões
 *   apontam por `skillId`), então renomear é seguro;
 * - `user_settings(userId @unique)`: se o dono já tem linha própria, a
 *   legada `id="default"` é apagada; senão, é reivindicada.
 */

export type ClaimDefaultCounts = Record<string, number>;

export type ValidateConstraintsResult = {
	validated: string[];
	failed: Array<{ constraint: string; reason: string }>;
};

export type ClaimDefaultResult = {
	claimedFor: string;
	updated: ClaimDefaultCounts;
};

const VALIDATE_CONSTRAINTS: Array<[table: string, constraint: string]> = [
	["memory_entries", "memory_entries_userId_fkey"],
	["agent_runs", "agent_runs_userId_fkey"],
	["skills", "skills_userId_fkey"],
	["skill_learning_jobs", "skill_learning_jobs_userId_fkey"],
	["skill_pending_intents", "skill_pending_intents_userId_fkey"],
	["routines", "routines_userId_fkey"],
	["mcp_connections", "mcp_connections_userId_fkey"],
];

/** Slug livre para o dono: "github", "github_2", "github_3"… */
function freeSlug(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Reatribui as linhas legadas ao `userId` (transação + lock, como o script). */
export async function claimDefaultData(userId: string): Promise<ClaimDefaultCounts> {
	const result = await prisma.$transaction(
		async (tx) => {
			// Serialize retries and prevent concurrent first-login claims.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(18072026, 1)`;

			// --- MCP: duplicadas por catálogo são apagadas (a própria ganha).
			const ownCatalogs = new Set(
				(
					await tx.mcpConnection.findMany({
						where: { userId, catalogId: { not: null } },
						select: { catalogId: true },
					})
				).map((row) => row.catalogId as string),
			);
			const defaultConns = await tx.mcpConnection.findMany({
				where: { userId: "default" },
				select: { id: true, catalogId: true, slug: true },
				orderBy: { createdAt: "asc" },
			});
			const duplicateIds = defaultConns
				.filter(
					(row) => row.catalogId !== null && ownCatalogs.has(row.catalogId),
				)
				.map((row) => row.id);
			let mcpConnectionDuplicatesDeleted = 0;
			if (duplicateIds.length > 0) {
				const deleted = await tx.mcpConnection.deleteMany({
					where: { id: { in: duplicateIds } },
				});
				mcpConnectionDuplicatesDeleted = deleted.count;
			}

			// --- MCP: slugs colididos são renomeados antes do updateMany.
			const takenSlugs = new Set(
				(
					await tx.mcpConnection.findMany({
						where: { userId },
						select: { slug: true },
					})
				).map((row) => row.slug),
			);
			for (const row of defaultConns) {
				if (duplicateIds.includes(row.id)) continue;
				if (!takenSlugs.has(row.slug)) {
					takenSlugs.add(row.slug);
					continue;
				}
				const renamed = freeSlug(row.slug, takenSlugs);
				takenSlugs.add(renamed);
				await tx.mcpConnection.update({
					where: { id: row.id },
					data: { slug: renamed },
				});
			}

			// --- Skills: as que colidem são reivindicadas como `<key>_legado`, desativadas.
			const takenSkillKeys = new Map<string, Set<string>>();
			const keysOfBot = (botId: string): Set<string> => {
				let set = takenSkillKeys.get(botId);
				if (!set) {
					set = new Set();
					takenSkillKeys.set(botId, set);
				}
				return set;
			};
			for (const row of await tx.skill.findMany({
				where: { userId },
				select: { botId: true, capabilityKey: true },
			})) {
				keysOfBot(row.botId).add(row.capabilityKey);
			}
			const defaultSkills = await tx.skill.findMany({
				where: { userId: "default" },
				select: { id: true, botId: true, capabilityKey: true },
				orderBy: { createdAt: "asc" },
			});
			const renamedSkillIds: string[] = [];
			for (const row of defaultSkills) {
				const taken = keysOfBot(row.botId);
				if (!taken.has(row.capabilityKey)) {
					taken.add(row.capabilityKey);
					continue;
				}
				const renamed = freeSlug(`${row.capabilityKey}_legado`, taken);
				taken.add(renamed);
				await tx.skill.update({
					where: { id: row.id },
					data: { userId, capabilityKey: renamed, enabled: false },
				});
				renamedSkillIds.push(row.id);
			}

			// --- Settings: dono com linha própria → apaga a legada; senão reivindica.
			const ownSettings = await tx.userSettings.findFirst({
				where: { userId },
				select: { id: true },
			});
			let settingsLegacyDeleted = 0;
			if (ownSettings) {
				const deleted = await tx.userSettings.deleteMany({
					where: { id: "default", userId: null },
				});
				settingsLegacyDeleted = deleted.count;
			}

			const updates = {
				bots: await tx.bot.updateMany({ where: { ownerId: null }, data: { ownerId: userId } }),
				sections: await tx.section.updateMany({ where: { ownerId: null }, data: { ownerId: userId } }),
				conversations: await tx.conversation.updateMany({ where: { userId: null }, data: { userId } }),
				settings: ownSettings
					? { count: 0 }
					: // A linha legada nunca guarda configJson (grava-se só por userId); zerar
						// garante que o claim não leve config de ninguém para o dono.
						await tx.userSettings.updateMany({
							where: { id: "default", userId: null },
							data: { userId, configJson: Prisma.DbNull },
						}),
				memoryEntries: await tx.memoryEntry.updateMany({ where: { userId: "default" }, data: { userId } }),
				agentRuns: await tx.agentRun.updateMany({ where: { userId: "default" }, data: { userId } }),
				skills: await tx.skill.updateMany({ where: { userId: "default" }, data: { userId } }),
				skillLearningJobs: await tx.skillLearningJob.updateMany({
					where: { userId: "default" },
					data: { userId },
				}),
				skillPendingIntents: await tx.skillPendingIntent.updateMany({
					where: { userId: "default" },
					data: { userId },
				}),
				routines: await tx.routine.updateMany({ where: { userId: "default" }, data: { userId } }),
				mcpConnections: await tx.mcpConnection.updateMany({
					where: { userId: "default" },
					data: { userId },
				}),
			};
			return {
				...Object.fromEntries(
					Object.entries(updates).map(([table, value]) => [table, value.count]),
				),
				mcpConnectionDuplicatesDeleted,
				skillsRenamedConflicts: renamedSkillIds.length,
				settingsLegacyDeleted,
			} as ClaimDefaultCounts;
		},
		{ timeout: 30_000 },
	);
	return result;
}

/**
 * Valida as 7 FKs NOT VALID, uma a uma (fora da transação, best-effort).
 * Constraint ausente (42704, migração não aplicada) ou com violação é logada
 * e a próxima continua — uma falha nunca impede validar as demais.
 */
export async function validateClaimDefaultConstraints(): Promise<ValidateConstraintsResult> {
	const validated: string[] = [];
	const failed: ValidateConstraintsResult["failed"] = [];
	for (const [table, constraint] of VALIDATE_CONSTRAINTS) {
		try {
			// Nomes fixos (nunca vêm de input do usuário) — seguro passar direto.
			await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${constraint}"`);
			validated.push(constraint);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const missing = reason.includes("42704") || /does not exist/i.test(reason);
			failed.push({ constraint, reason });
			console.error(
				`[claim-default] VALIDATE CONSTRAINT ${constraint} ${missing ? "ausente (migração não aplicada?)" : "falhou"}: ${reason}`,
			);
		}
	}
	console.log(
		`[claim-default] FKs validadas: ${validated.length}/${VALIDATE_CONSTRAINTS.length}` +
			(failed.length > 0 ? `; falharam: ${failed.map((f) => f.constraint).join(", ")}` : ""),
	);
	return { validated, failed };
}

/**
 * Totais reivindicados + validação, para o script manual e o boot.
 * O script valida o dono antes; o boot usa `maybeClaimDefaultOnBoot`.
 */
export async function claimDefaultAndValidate(userId: string): Promise<ClaimDefaultResult> {
	const updated = await claimDefaultData(userId);
	await validateClaimDefaultConstraints(); // best-effort: falhas já logadas por constraint
	return { claimedFor: userId, updated };
}

/**
 * Claim automático no boot da API (F1): só quando há exatamente 1 usuário e
 * o e-mail dele é o `ATLAS_OWNER_EMAIL`. Fora disso, não faz nada
 * (`{ skipped }`) — nunca derruba o boot.
 */
export async function maybeClaimDefaultOnBoot(): Promise<
	| { claimedFor: string; updated: ClaimDefaultCounts; validated: string[] }
	| { skipped: string }
> {
	try {
		const ownerEmail = process.env.ATLAS_OWNER_EMAIL?.trim().toLowerCase();
		if (!ownerEmail) return { skipped: "sem ATLAS_OWNER_EMAIL" };
		const users = await prisma.user.findMany({ select: { id: true, email: true } });
		if (users.length !== 1) return { skipped: `claim-default no boot: ${users.length} usuários (exige 1)` };
		const sole = users[0];
		if (!sole || sole.email.toLowerCase() !== ownerEmail) {
			return { skipped: "claim-default no boot: único usuário não é o ATLAS_OWNER_EMAIL" };
		}
		const updated = await claimDefaultData(sole.id);
		// Validação é best-effort no boot (script manual valida depois).
		const { validated } = await validateClaimDefaultConstraints();
		return { claimedFor: sole.id, updated, validated };
	} catch (error) {
		console.error("[claim-default] falhou no boot (best-effort)", error);
		return { skipped: `claim-default no boot falhou: ${error instanceof Error ? error.message : String(error)}` };
	}
}
