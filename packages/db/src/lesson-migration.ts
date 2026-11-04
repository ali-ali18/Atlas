/**
 * Lições → fatos (motor v3, PR8c). Duas etapas, separadas de propósito:
 *  1. `buildLessonMigrationReport`: SÓ LEITURA. Lê as lições ativas de cada dono/bot e monta o relatório (decisão pura de
 *     `planLessonFacts`, em shared). Nunca grava.
 *  2. `applyLessonMigration`: grava os fatos aprovados na memória do bot. Só roda pelo script com `--apply` e `--user`,
 *     com o ok do dono. Não aposenta nenhuma lição: v1 e v2 ainda as injetam, então a lição continua intacta.
 * Toda leitura e escrita passa pelo `userId` do dono (funções que já filtram por ele); o relatório sai uma seção por dono.
 */
import {
	applicableFacts,
	planLessonFacts,
	renderLessonFactsReport,
	type LessonFactInput,
	type LessonFactPlan,
	type LessonFactReportOwner,
	type LessonView,
	type MemoryActionResult,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { listBotLessons } from "./bot-lessons.js";
import { addMemoryEntry, loadStore } from "./memory-entries.js";

export type LessonOwnerRef = { userId: string; botId: string };

export type LessonMigrationDeps = {
	/** Pares dono/bot com lição ativa. `userId` restringe a um dono. */
	listOwners: (filter: { userId?: string; botId?: string }) => Promise<LessonOwnerRef[]>;
	listLessons: (userId: string, botId: string) => Promise<LessonView[]>;
	listFacts: (userId: string, botId: string) => Promise<{ texts: string[]; used: number; limit: number }>;
	addFact: (input: { userId: string; botId: string; content: string }) => Promise<MemoryActionResult>;
	/** Nome de exibição dos conectores do dono, por `mcp:<id>`. Sem isso, o fato de conector sai sem contexto. */
	connectorNames?: (userId: string) => Promise<ReadonlyMap<string, string>>;
	now?: () => Date;
};

export const LESSON_MIGRATION_SOURCE = "lesson-migration";

export const defaultLessonMigrationDeps: LessonMigrationDeps = {
	listOwners: async (filter) => {
		const rows = await prisma.botLesson.findMany({
			where: { status: "active", ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.botId ? { botId: filter.botId } : {}) },
			select: { userId: true, botId: true },
			distinct: ["userId", "botId"],
			orderBy: [{ userId: "asc" }, { botId: "asc" }],
		});
		return rows;
	},
	listLessons: listBotLessons,
	listFacts: async (userId, botId) => {
		const store = await loadStore(userId, botId, "memory");
		return { texts: store.rows.map((row) => row.content), used: store.used, limit: store.limit };
	},
	connectorNames: async (userId) => {
		const rows = await prisma.mcpConnection.findMany({ where: { userId }, select: { id: true, name: true } });
		return new Map(rows.map((row) => [`mcp:${row.id}`, row.name] as const));
	},
	addFact: ({ userId, botId, content }) => addMemoryEntry({ userId, botId, target: "memory", content, source: LESSON_MIGRATION_SOURCE, origin: "review" }),
};

function toInput(lesson: LessonView, names: ReadonlyMap<string, string>): LessonFactInput {
	const label = lesson.scope === "connector" && lesson.scopeKey ? names.get(lesson.scopeKey) : undefined;
	return {
		id: lesson.id,
		ref: lesson.ref,
		scope: lesson.scope,
		scopeKey: lesson.scopeKey,
		...(label ? { scopeLabel: label } : {}),
		content: lesson.content,
		helpful: lesson.helpful,
		harmful: lesson.harmful,
		uses: lesson.uses,
		createdAt: lesson.createdAt,
		updatedAt: lesson.updatedAt,
		lastUsedAt: lesson.lastUsedAt,
	};
}

async function planFor(owner: LessonOwnerRef, deps: LessonMigrationDeps): Promise<LessonFactPlan> {
	// `listLessons` confere que o bot é do dono; bot de outro dono volta vazio.
	const lessons = await deps.listLessons(owner.userId, owner.botId);
	const facts = await deps.listFacts(owner.userId, owner.botId);
	const names = lessons.some((lesson) => lesson.scope === "connector") ? ((await deps.connectorNames?.(owner.userId)) ?? new Map<string, string>()) : new Map<string, string>();
	return planLessonFacts({
		lessons: lessons.map((lesson) => toInput(lesson, names)),
		existingFacts: facts.texts,
		budget: { limit: facts.limit, used: facts.used },
		now: (deps.now ?? (() => new Date()))(),
	});
}

/** Etapa 1 (somente leitura): um plano por dono e bot. */
export async function buildLessonMigrationReport(
	filter: { userId?: string; botId?: string } = {},
	deps: LessonMigrationDeps = defaultLessonMigrationDeps,
): Promise<{ owners: LessonFactReportOwner[]; markdown: string }> {
	const refs = await deps.listOwners(filter);
	const owners: LessonFactReportOwner[] = [];
	for (const ref of refs) {
		// Defesa em profundidade: um filtro de dono nunca devolve outro dono.
		if (filter.userId && ref.userId !== filter.userId) continue;
		const plan = await planFor(ref, deps);
		if (plan.counts.total > 0) owners.push({ ...ref, plan });
	}
	return { owners, markdown: renderLessonFactsReport(owners, (deps.now ?? (() => new Date()))()) };
}

export type LessonApplyResult = { userId: string; botId: string; written: number; skipped: number; failed: Array<{ ref: string; error: string }> };

/**
 * Etapa 2 (só com o ok do dono): grava como fato o que o plano manda virar fato e não pede revisão. Exige o dono
 * (`userId`), não aposenta lição e é idempotente: o plano já descarta o que a memória tem, e o `addMemoryEntry` recusa
 * texto igual ("duplicado"), que conta como pulado.
 */
export async function applyLessonMigration(
	input: { userId: string; botId?: string },
	deps: LessonMigrationDeps = defaultLessonMigrationDeps,
): Promise<LessonApplyResult[]> {
	if (!input.userId.trim()) throw new Error("applyLessonMigration exige o userId do dono");
	const results: LessonApplyResult[] = [];
	for (const ref of await deps.listOwners({ userId: input.userId, ...(input.botId ? { botId: input.botId } : {}) })) {
		if (ref.userId !== input.userId) continue;
		const plan = await planFor(ref, deps);
		const result: LessonApplyResult = { userId: ref.userId, botId: ref.botId, written: 0, skipped: plan.counts.total - applicableFacts(plan).length, failed: [] };
		for (const item of applicableFacts(plan)) {
			const outcome = await deps.addFact({ userId: ref.userId, botId: ref.botId, content: item.factText });
			if (outcome.ok) result.written += 1;
			else if (outcome.error === "duplicado") result.skipped += 1;
			else result.failed.push({ ref: item.ref, error: outcome.error });
		}
		results.push(result);
	}
	return results;
}

export type LessonMigrationArgs =
	| { ok: true; mode: "report"; out: string; userId?: string; botId?: string }
	| { ok: true; mode: "apply"; userId: string; botId?: string }
	| { ok: false; error: string };

/** Argumentos do script. `--apply` exige `--user` (escopo de um dono só); sem `--apply` exige `--out`. */
export function parseLessonMigrationArgs(argv: readonly string[]): LessonMigrationArgs {
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) return { ok: false, error: `argumento inesperado: ${arg}` };
		const eq = arg.indexOf("=");
		const name = arg.slice(2, eq === -1 ? undefined : eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		if (!["apply", "out", "user", "bot"].includes(name)) return { ok: false, error: `flag desconhecida: --${name}` };
		if (name === "apply") {
			// `--apply=false` não pode virar "aplicar": a flag não aceita valor.
			if (inline !== undefined) return { ok: false, error: "--apply não aceita valor (use só --apply para gravar; sem a flag, nada é gravado)" };
			flags.set(name, true);
			continue;
		}
		const value = inline ?? argv[++i];
		if (!value || value.startsWith("--")) return { ok: false, error: `--${name} pede um valor` };
		flags.set(name, value);
	}
	const userId = typeof flags.get("user") === "string" ? (flags.get("user") as string) : undefined;
	const botId = typeof flags.get("bot") === "string" ? (flags.get("bot") as string) : undefined;
	if (flags.has("apply")) {
		if (!userId) return { ok: false, error: "--apply exige --user <id do dono>" };
		if (flags.has("out")) return { ok: false, error: "--apply não gera relatório: use --out sem --apply" };
		return { ok: true, mode: "apply", userId, ...(botId ? { botId } : {}) };
	}
	const out = flags.get("out");
	if (typeof out !== "string") return { ok: false, error: "informe --out <arquivo.md> para o relatório" };
	return { ok: true, mode: "report", out, ...(userId ? { userId } : {}), ...(botId ? { botId } : {}) };
}
