import { getAccountConfig, onGroupTurnCreated, processGroupTurns, type GroupDispatchDeps } from "@workspace/db";
import { buildGroupRouterPrompt, parseGroupRouterReply, resolveEffectiveConfig } from "@workspace/shared";
import { askJev } from "@workspace/llm";
import type { WorkerConfig } from "./config.js";
import { createMaintenanceLlm } from "./maintenance-llm.js";

const SWEEP_INTERVAL_MS = 1_500;
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
	deps: { loadConfig?: typeof getAccountConfig; ask?: typeof askJev; env?: NodeJS.ProcessEnv } = {},
): NonNullable<GroupDispatchDeps["jev"]> {
	return {
		enabled: async (userId) => {
			if (!config.openRouterApiKey) return false;
			try {
				const account = await (deps.loadConfig ?? getAccountConfig)(userId);
				return resolveEffectiveConfig({ user: { config: account }, env: deps.env ?? process.env }).groups.jevCoordination.value;
			} catch {
				return false;
			}
		},
		ask: async ({ state, questions }) => {
			const result = await (deps.ask ?? askJev)({ apiKey: config.openRouterApiKey!, state, questions, timeoutMs: GROUP_JEV_TIMEOUT_MS });
			return result.answers;
		},
	};
}

/**
 * Despacho de grupos de bots: roteia a fala do usuário, enfileira as respostas dos
 * membros e inicia uma por vez. Um passo por vez (sem sobreposição); pedido de passo
 * durante outro roda de novo ao terminar. Nunca lança.
 */
export function startGroupSweeper(deps: GroupDispatchDeps): { kick: () => void; stop: () => void } {
	let running = false;
	let again = false;
	const sweep = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				const result = await processGroupTurns(deps);
				if (result.routed + result.started + result.settled + result.followUps > 0) {
					console.log(
						`[bot-groups] roteados=${result.routed} iniciadas=${result.started} encerradas=${result.settled} por-mencao=${result.followUps} adiadas=${result.busy}`,
					);
				}
			} while (again);
		} catch (error) {
			console.error("[bot-groups] sweep failed", error);
		} finally {
			running = false;
		}
	};
	const kick = (): void => {
		void sweep();
	};
	const timer = setInterval(kick, SWEEP_INTERVAL_MS);
	const unsubscribe = onGroupTurnCreated(kick);
	return {
		kick,
		stop: () => {
			clearInterval(timer);
			unsubscribe();
		},
	};
}
