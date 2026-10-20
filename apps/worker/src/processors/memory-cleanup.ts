import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { reviewMemoryEntries, type MemoryCleanupDraft, type MemoryGateDeps } from "@workspace/agent-runtime";
import {
	ATLAS_JOB_NAMES,
	MEMORY_CLEANUP_MAX_SUGGESTIONS,
	friendlyMaintenanceError,
	type MemoryCleanupJobPayload,
	type MemoryCleanupJobResult,
	type MemoryCleanupSuggestion,
	type MemoryTarget,
} from "@workspace/shared";
import { getMemoryCleanup, getMemorySnapshot, markMemoryCleanupFailed, setMemoryCleanupSuggestions } from "@workspace/db";
import type { WorkerConfig } from "../config.js";
import { buildMemoryGateDeps } from "../memory-gate.js";

type Layers = Awaited<ReturnType<typeof getMemorySnapshot>>;

export type MemoryCleanupDeps = {
	snapshot?: (userId: string, botId: string) => Promise<Pick<Layers, "user" | "memory">>;
	gate?: (userId: string, config: WorkerConfig) => Promise<MemoryGateDeps>;
	owns?: (userId: string, botId: string) => Promise<boolean>;
	save?: (userId: string, botId: string, list: MemoryCleanupSuggestion[]) => Promise<unknown>;
	fail?: (userId: string, botId: string, message: string) => Promise<unknown>;
	newId?: () => string;
	now?: () => Date;
};

/**
 * Revisa TODAS as entradas da memória do bot e do perfil do usuário e grava SUGESTÕES de limpeza (apagar/fundir).
 * Não muda nenhuma memória: quem aplica é o usuário, na aba Memória. Falha vira estado visível, sem nova tentativa.
 */
export async function processMemoryCleanup(
	job: Pick<Job<MemoryCleanupJobPayload, MemoryCleanupJobResult>, "name" | "data" | "id">,
	config: WorkerConfig,
	deps: MemoryCleanupDeps = {},
): Promise<MemoryCleanupJobResult> {
	if (job.name !== ATLAS_JOB_NAMES.memoryCleanup) throw new Error(`Unexpected job name: ${job.name}`);
	const { userId, botId } = job.data;
	const newId = deps.newId ?? randomUUID;
	const now = deps.now ?? (() => new Date());
	if (!(await (deps.owns ?? (async (u, b) => (await getMemoryCleanup(u, b)) !== null))(userId, botId))) return { status: "skipped", reason: "bot não encontrado" };
	console.log(`[memory.cleanup] start job=${job.id} botId=${botId}`);
	try {
		const snapshot = await (deps.snapshot ?? getMemorySnapshot)(userId, botId);
		const gate = await (deps.gate ?? ((id, cfg) => buildMemoryGateDeps({ userId: id, config: cfg })))(userId, config);
		const suggestions: MemoryCleanupSuggestion[] = [];
		for (const target of ["memory", "user"] as const satisfies readonly MemoryTarget[]) {
			const entries = snapshot[target].entries.map((entry) => ({ id: entry.id, content: entry.content }));
			const drafts = await reviewMemoryEntries({ entries }, gate);
			const text = new Map(entries.map((entry) => [entry.id, entry.content]));
			for (const draft of drafts) suggestions.push(toSuggestion(draft, target, text, newId(), now()));
		}
		await (deps.save ?? setMemoryCleanupSuggestions)(userId, botId, suggestions.slice(0, MEMORY_CLEANUP_MAX_SUGGESTIONS));
		console.log(`[memory.cleanup] done job=${job.id} suggestions=${suggestions.length}`);
		return { status: "done", suggestions: suggestions.length };
	} catch (error) {
		console.warn(`[memory.cleanup] failed job=${job.id} (${error instanceof Error ? error.name : "erro"})`);
		await (deps.fail ?? markMemoryCleanupFailed)(userId, botId, friendlyMaintenanceError(error)).catch(() => undefined);
		return { status: "failed", reason: friendlyMaintenanceError(error) };
	}
}

function toSuggestion(draft: MemoryCleanupDraft, target: MemoryTarget, text: Map<string, string>, id: string, at: Date): MemoryCleanupSuggestion {
	return {
		id,
		kind: draft.kind,
		target,
		entryIds: [...draft.entryIds],
		before: draft.entryIds.map((entryId) => text.get(entryId) ?? ""),
		...(draft.kind === "merge" ? { content: draft.content } : {}),
		reason: draft.reason,
		createdAt: at.toISOString(),
	};
}
