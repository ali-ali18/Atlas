import { createMemoryJudge, createReviewerClient, type MemoryGateDeps, type MemoryJudge, type ReviewerLlmDeps } from "@workspace/agent-runtime";
import { getAccountConfig, getMemorySnapshot } from "@workspace/db";
import { resolveEffectiveConfig, type MemoryTarget } from "@workspace/shared";
import type { WorkerConfig } from "./config.js";
import { createMaintenanceLlm, type MaintenanceLlm } from "./maintenance-llm.js";

/** Fora da conversa há folga: o Jev e o modelo de manutenção podem levar mais que dentro do run. */
const JEV_TIMEOUT_MS = 6_000;
const COMPLETE_TIMEOUT_MS = 20_000;

export type MemoryGatePorts = {
	loadConfig?: typeof getAccountConfig;
	env?: NodeJS.ProcessEnv;
	reviewer?: ReviewerLlmDeps;
	llm?: (userId: string | undefined, config: WorkerConfig) => Promise<MaintenanceLlm>;
};

/**
 * Ferramentas do porteiro para um usuário: o Jev (se a conta ligou o item "Porteiro da memória" e há revisor) e o
 * modelo de manutenção (escreve o texto fundido e julga sozinho quando não há Jev). Cada parte que falhar ao montar
 * simplesmente fica de fora; sem nenhuma, o porteiro deixa tudo passar.
 */
export async function buildMemoryGateDeps(input: { userId?: string; config: WorkerConfig }, ports: MemoryGatePorts = {}): Promise<MemoryGateDeps> {
	const { userId, config } = input;
	let ask: MemoryGateDeps["ask"];
	if (userId) {
		try {
			const account = await (ports.loadConfig ?? getAccountConfig)(userId);
			const mode = resolveEffectiveConfig({ user: { config: account }, env: ports.env ?? process.env }).jev.features.memory.value;
			if (mode === "on") {
				const reviewer = await createReviewerClient({ userId, config }, ports.reviewer);
				if (reviewer.available) ask = reviewer.ask;
			}
		} catch (error) {
			console.warn(`[memory.gate] warn jev unavailable (${error instanceof Error ? error.name : "erro"})`);
		}
	}
	let complete: MemoryGateDeps["complete"];
	try {
		const llm = await (ports.llm ?? ((id, cfg) => createMaintenanceLlm({ kind: "memory-gate", config: cfg, userId: id })))(userId, config);
		if (llm.candidates.length > 0) {
			complete = async (request) => {
				try {
					const result = await llm.complete({
						model: llm.model,
						apiKey: "",
						messages: [
							{ role: "system", content: request.system },
							{ role: "user", content: request.user },
						],
						timeoutMs: request.timeoutMs,
						signal: request.signal,
					});
					void llm.report({ ok: true });
					return result.message.content;
				} catch (error) {
					void llm.report({ ok: false, error });
					throw error;
				}
			};
		}
	} catch (error) {
		console.warn(`[memory.gate] warn maintenance model unavailable (${error instanceof Error ? error.name : "erro"})`);
	}
	return { ask, complete, jevTimeoutMs: JEV_TIMEOUT_MS, completeTimeoutMs: COMPLETE_TIMEOUT_MS };
}

export async function buildMemoryJudge(input: { userId?: string; config: WorkerConfig }, ports: MemoryGatePorts = {}): Promise<MemoryJudge> {
	return createMemoryJudge(await buildMemoryGateDeps(input, ports));
}

/** Camadas atuais no formato do porteiro; falha ao ler = vazias (o porteiro ainda julga o fato). */
export async function loadGateLayers(
	userId: string | undefined,
	botId: string | undefined,
	snapshot: typeof getMemorySnapshot = getMemorySnapshot,
): Promise<Record<MemoryTarget, { id: string; content: string }[]>> {
	const view = await snapshot(userId, botId).catch(() => null);
	const pick = (entries: { id: string; content: string }[] | undefined) => (entries ?? []).map((entry) => ({ id: entry.id, content: entry.content }));
	return { user: pick(view?.user.entries), memory: pick(view?.memory.entries) };
}
