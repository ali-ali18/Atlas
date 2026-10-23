/**
 * Simulações 1–5 (`src/simulations/scenarios.ts`) contra um modelo REAL via OpenRouter. Opcional, fora do CI:
 * gasta tokens e depende do modelo. Imprime uma tabela cenário → passou/falhou.
 *
 * Uso (na raiz do pacote agent-runtime):
 *   OPENROUTER_API_KEY=... pnpm exec tsx scripts/sim-real-model.mts
 *   SIM_MODEL=qwen/qwen3-235b-a22b OPENROUTER_API_KEY=... pnpm exec tsx scripts/sim-real-model.mts
 *
 * - SIM_MODEL: id do modelo no OpenRouter (padrão: deepseek/deepseek-chat-v3.1).
 * - Roda sem banco: o run não tem dono nem bot (nada é gravado); tools que precisam do banco falham e o modelo vê o
 *   erro real, o que basta para conferir se ele agiu, perguntou ou prometeu.
 * - A chave nunca é impressa nem gravada.
 */
import type { ScenarioOutcome } from "../src/simulations/scenarios.js";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model = process.env.SIM_MODEL?.trim() || "deepseek/deepseek-chat-v3.1";
const TIMEOUT_MS = 120_000;

if (!apiKey) {
	console.error("Defina OPENROUTER_API_KEY para rodar as simulações com modelo real (a chave não é impressa).");
	process.exit(2);
}

// O pacote do banco exige um pepper ao carregar; a simulação não grava nada, então um valor local basta.
process.env.ATLAS_HOOK_PEPPER ||= "sim-real-model-local-only";
const { runComputerUse } = await import("../src/computer-use.js");
const { SCENARIOS } = await import("../src/simulations/scenarios.js");

async function runScenario(messages: Array<{ role: "user" | "assistant"; content: string }>): Promise<ScenarioOutcome> {
	const toolsCalled: string[] = [];
	const discards: string[] = [];
	const systemNotes: string[] = [];
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
	try {
		const result = await runComputerUse({
			manager: {} as never,
			getSessionId: async () => {
				throw new Error("sem sandbox na simulação");
			},
			sandboxEnabled: false,
			apiKey: apiKey!,
			model,
			runId: `sim-${Date.now()}`,
			origin: "chat",
			contextEconomy: true,
			messages,
			maxSteps: 8,
			abortSignal: abort.signal,
			onEvent: (event) => {
				if (event.type === "tool_result") toolsCalled.push(event.name);
				if (event.type === "assistant_discard") discards.push(String(event.reason));
			},
			onStep: async () => undefined,
		});
		return { text: result.text, toolsCalled, discards, systemNotes: systemNotes.join("\n") };
	} finally {
		clearTimeout(timer);
	}
}

const rows: Array<{ id: number; name: string; result: string }> = [];
for (const scenario of SCENARIOS) {
	let result: string;
	try {
		const outcome = await runScenario(scenario.messages);
		const problem = scenario.check(outcome);
		result = problem ? `FALHOU: ${problem}` : "passou";
		console.log(`\n#${scenario.id} resposta final:\n${outcome.text.slice(0, 600)}`);
	} catch (error) {
		result = `ERRO: ${error instanceof Error ? error.message.slice(0, 160) : "desconhecido"}`;
	}
	rows.push({ id: scenario.id, name: scenario.name, result });
}

console.log(`\nModelo: ${model}`);
console.table(rows);
process.exit(rows.every((row) => row.result === "passou") ? 0 : 1);
