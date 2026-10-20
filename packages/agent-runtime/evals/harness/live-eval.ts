import "../web/env.js";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "../../src/computer-use.js";
import { buildMcpToolset } from "../../src/mcp/registry.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { CUSTOMER_ID, ERP_CONNECTION, EXPOSED, PAYMENT_30D, SKU_A, fakeErp } from "../../src/harness-regression.fixtures.js";

// Eval ao vivo OPT-IN da tarefa de varios passos sobre o conector falso `erp` (achar cliente, listar itens e formas
// de pagamento, criar pedido). Gasta dinheiro com um modelo real e NUNCA roda no CI nem em `pnpm test`: sem
// HARNESS_LIVE_EVAL=1 ele so avisa que foi ignorado e sai com sucesso. Nao e a suite de regressao (essa e
// deterministica, em src/harness-regression.test.ts): aqui se mede se um modelo de verdade, dentro do harness, termina
// a tarefa sem repetir chamada que falha e sem tentar escrever com campo obrigatorio faltando.
//
//   HARNESS_LIVE_EVAL=1 HARNESS_LIVE_MODEL=<id do modelo no OpenRouter> pnpm --filter @workspace/agent-runtime eval:harness -- --env-file <.env>
//
// A chave vem so do ambiente existente (OPENROUTER_API_KEY, como em eval:web); nada e gravado aqui. Opcional:
// HARNESS_LIVE_MAX_COST (US$, padrao 0.25) e HARNESS_LIVE_MAX_STEPS (padrao 25). Dados 100% ficticios.

const TASK = [
	"Create a sales order for the customer named \"Cliente Exemplo\": 2 units of the item priced 25.50,",
	"paid with the 30-day boleto payment method, due in 30 days.",
	"Look up the customer, the item and the payment method in the ERP first; do not guess ids.",
].join(" ");

type ToolResultEvent = { type: "tool_result"; name: string; ok: boolean; summary: string };

function summarize(input: { erpCalls: ReturnType<typeof fakeErp>["calls"]; results: ToolResultEvent[]; error?: unknown }) {
	const orderCalls = input.erpCalls.filter((c) => c.name === EXPOSED.createOrder);
	const orderResults = input.results.filter((r) => r.name === EXPOSED.createOrder);
	// Escrita barrada pela validacao antes de qualquer cartao/execucao: o modelo tentou com campo faltando.
	const missingFieldAttempts = orderResults.filter((r) => !r.ok && r.summary.includes("Nada foi executado nem enviado")).length;
	const failedByErp = orderCalls.length > 0 ? orderResults.filter((r) => !r.ok && !r.summary.includes("Nada foi executado nem enviado")).length : 0;
	const seen = new Map<string, number>();
	for (const call of input.erpCalls) {
		const key = `${call.name}:${JSON.stringify(call.args)}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	// "Chamada que falha repetida": a mesma escrita igual chegando mais de uma vez ao ERP depois de falhar.
	const repeatedFailingCalls = [...seen].filter(([key, n]) => key.startsWith(`${EXPOSED.createOrder}:`) && n > 1 && failedByErp > 0).length;
	const completed = orderCalls.some((c) => {
		const items = Array.isArray(c.args.items) ? (c.args.items as Array<Record<string, unknown>>) : [];
		return c.args.customer_id === CUSTOMER_ID && c.args.payment_method_id === PAYMENT_30D && items.some((i) => i.sku === SKU_A && Number(i.qty) === 2);
	}) && orderResults.some((r) => r.ok);
	return { completed, missingFieldAttempts, repeatedFailingCalls, failedByErp, erpCalls: input.erpCalls.length, error: input.error ? String(input.error) : undefined };
}

async function main() {
	if (process.env.HARNESS_LIVE_EVAL !== "1") {
		console.log("[eval:harness] ignorado: defina HARNESS_LIVE_EVAL=1 (e HARNESS_LIVE_MODEL) para gastar com um modelo real. Nada foi executado.");
		return;
	}
	const model = process.env.HARNESS_LIVE_MODEL?.trim();
	if (!model) throw new Error("HARNESS_LIVE_MODEL ausente: informe o id do modelo.");
	const apiKey = process.env.OPENROUTER_API_KEY ?? "";
	if (!apiKey) throw new Error("OPENROUTER_API_KEY ausente: passe --env-file <caminho do .env>.");

	const erp = fakeErp();
	// Autonomo: a escrita executa sem cartao (nao ha conversa nem banco aqui); a validacao de argumentos continua valendo.
	const autonomy = { level: "autonomous" as const, exceptions: [] };
	const mcp: McpRuntime = { toolset: buildMcpToolset([ERP_CONNECTION], { autonomy }), call: erp.call };
	const results: ToolResultEvent[] = [];
	let error: unknown;
	try {
		await runComputerUse({
			manager: {} as SandboxManager,
			getSessionId: async () => "unused",
			sandboxEnabled: false,
			apiKey,
			model,
			runId: `harness-live-${Date.now().toString(36)}`,
			userId: "eval-harness",
			origin: "chat",
			language: "en-US",
			mcp,
			autonomy,
			maxSteps: Number(process.env.HARNESS_LIVE_MAX_STEPS ?? "25"),
			budget: { maxCostUsd: Number(process.env.HARNESS_LIVE_MAX_COST ?? "0.25") },
			messages: [{ role: "user", content: TASK }],
			onEvent: (event) => {
				if (event.type === "tool_result") results.push(event as unknown as ToolResultEvent);
			},
		});
	} catch (caught) {
		error = caught;
	}

	const summary = summarize({ erpCalls: erp.calls, results, error });
	const checks: Array<[string, boolean]> = [
		["tarefa concluida (pedido criado com cliente, item e pagamento corretos)", summary.completed],
		["nenhuma chamada que falhou foi repetida igual", summary.repeatedFailingCalls === 0],
		["nenhuma escrita tentada com campo obrigatorio faltando", summary.missingFieldAttempts === 0],
	];
	console.log(`[eval:harness] modelo=${model} chamadas ao ERP=${summary.erpCalls} recusas do ERP=${summary.failedByErp}${summary.error ? ` erro=${summary.error}` : ""}`);
	for (const [label, pass] of checks) console.log(`[eval:harness] ${pass ? "PASS" : "FAIL"} ${label}`);
	const failed = checks.some(([, pass]) => !pass);
	console.log(`[eval:harness] ${failed ? "RESULTADO: FALHOU" : "RESULTADO: OK"}`);
	if (failed) process.exitCode = 1;
}

main().catch((caught) => {
	console.error("[eval:harness]", caught);
	process.exitCode = 1;
});
