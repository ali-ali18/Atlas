import { autoDecideGroupPending, getAccountConfig, onGroupTurnCreated, processGroupTurns, type GroupDispatchDeps, type GroupDispatchResult } from "@workspace/db";
import { buildGroupRouterPrompt, parseGroupRouterReply, resolveEffectiveConfig } from "@workspace/shared";
import { createReviewerClient, type ReviewerLlmDeps } from "@workspace/agent-runtime";
import type { askJev } from "@workspace/llm";
import type { WorkerConfig } from "./config.js";
import { createMaintenanceLlm } from "./maintenance-llm.js";
import { startAdaptiveSweeper, type AdaptiveSweeper } from "./adaptive-sweeper.js";

/** Com turno roteando ou ativo: volta logo, como antes. */
export const GROUP_SWEEP_BUSY_MS = 1_500;
/**
 * Sem turno aberto: só consulta de segurança. Turno novo acorda na hora (gancho no processo ou aviso do
 * Redis vindo da API) e o fim de um run no worker também.
 */
export const GROUP_SWEEP_IDLE_MS = 15_000;
const ROUTER_TIMEOUT_MS = 12_000;

/**
 * Roteador LLM de grupos: uma chamada barata (modelo de manutenção da conta), só
 * quando as regras (menção, nome, papel, bot principal) não decidem. Falha = vazio
 * (quem chama cai no primeiro membro).
 */
export function createGroupRouter(config: WorkerConfig): NonNullable<GroupDispatchDeps["route"]> {
	return async ({ userId, groupName, text, members }) => {
		// Mesma cadeia da manutenção (chave própria ou OpenRouter); sem nenhuma chave = vazio.
		const llm = await createMaintenanceLlm({ kind: "memory-review", config, userId });
		if (llm.candidates.length === 0) return [];
		const prompt = buildGroupRouterPrompt({ groupName, text, members });
		const result = await llm.completeWithTools({
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			model: llm.model,
			apiKey: "",
			tools: [],
			toolChoice: "none",
			timeoutMs: ROUTER_TIMEOUT_MS,
			maxOutputTokens: 120,
		});
		const content = typeof result.message.content === "string" ? result.message.content : "";
		return parseGroupRouterReply(content, members);
	};
}

const GROUP_JEV_TIMEOUT_MS = 4_000;

/**
 * Coordenação inteligente de grupos (Jev). Só liga quando a conta ativou
 * "Grupos: coordenação inteligente" e o servidor tem a chave do OpenRouter; qualquer
 * falha vira exceção em `ask` e quem chama cai no fluxo base.
 */
export function createGroupJev(
	config: WorkerConfig,
	deps: { loadConfig?: typeof getAccountConfig; ask?: typeof askJev; env?: NodeJS.ProcessEnv; reviewer?: ReviewerLlmDeps } = {},
): NonNullable<GroupDispatchDeps["jev"]> {
	return {
		enabled: async (userId) => {
			try {
				const account = await (deps.loadConfig ?? getAccountConfig)(userId);
				if (!resolveEffectiveConfig({ user: { config: account }, env: deps.env ?? process.env }).groups.jevCoordination.value) return false;
				// O revisor pode ser o Jev no OpenRouter, o modelo escolhido ou a cadeia da manutenção.
				return (await createReviewerClient({ userId, config }, { askJev: deps.ask, ...deps.reviewer })).available;
			} catch {
				return false;
			}
		},
		ask: async ({ userId, state, questions }) => {
			const reviewer = await createReviewerClient({ userId, config }, { askJev: deps.ask, ...deps.reviewer });
			if (!reviewer.available) throw new Error("Revisor indisponível");
			const result = await reviewer.ask({ state, questions, timeoutMs: GROUP_JEV_TIMEOUT_MS });
			return result.answers;
		},
	};
}

/**
 * Um passo do grupo + o aceite do bot principal para os pedidos seguros dos membros (regra pura, sem LLM).
 * Falha no aceite nunca derruba o despacho: o cartão só continua esperando o usuário.
 */
export async function processGroupTurnsAndPending(deps: GroupDispatchDeps): Promise<GroupDispatchResult> {
	const result = await processGroupTurns(deps);
	await autoDecideGroupPending(deps.now?.()).catch((error) => console.error("[bot-groups] group pending failed", error instanceof Error ? error.name : "error"));
	return result;
}

/**
 * Despacho de grupos de bots: roteia a fala do usuário, enfileira as respostas dos
 * membros e inicia uma por vez. Um passo por vez (sem sobreposição); pedido de passo
 * durante outro roda de novo ao terminar. Nunca lança.
 */
export function startGroupSweeper(
	deps: GroupDispatchDeps,
	options: {
		step?: (deps: GroupDispatchDeps) => Promise<GroupDispatchResult>;
		triggers?: Array<(kick: () => void) => () => void>;
		busyMs?: number;
		idleMs?: number;
	} = {},
): AdaptiveSweeper {
	const step = options.step ?? processGroupTurnsAndPending;
	return startAdaptiveSweeper({
		name: "bot-groups",
		step: () => step(deps),
		onResult: (result) => {
			if (result.routed + result.started + result.settled + result.followUps > 0) {
				console.log(
					`[bot-groups] roteados=${result.routed} iniciadas=${result.started} encerradas=${result.settled} por-mencao=${result.followUps} adiadas=${result.busy}`,
				);
			}
		},
		busyMs: options.busyMs ?? GROUP_SWEEP_BUSY_MS,
		idleMs: options.idleMs ?? GROUP_SWEEP_IDLE_MS,
		triggers: [onGroupTurnCreated, ...(options.triggers ?? [])],
	});
}
