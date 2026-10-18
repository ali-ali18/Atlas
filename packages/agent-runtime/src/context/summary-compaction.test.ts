import { describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { createTaskState } from "@workspace/shared";
import { applyPromptHygiene, estimateMessagesTokens, trimHistory } from "../hygiene.js";
import {
	STANDARD_CONTEXT_CAP_DEFAULT,
	contextBudgetFor,
	contextBudgetFromEnv,
	standardContextBudget,
	type ContextBudget,
} from "./budget.js";
import {
	SUMMARY_MAX_OUTPUT_TOKENS,
	SUMMARY_NOTE_PREFIX,
	buildSummaryRequest,
	compactWithSummary,
	createStreamSummarizer,
	type SummarizeFn,
} from "./summary-compaction.js";

const refLine = (id: string) => `[Full result stored as artifact:${id} (9000 chars). It stays in context for now; if it is collapsed later, re-read it with artifact_read instead of repeating the call.]`;
const budget: ContextBudget = { targetTokens: 3_000, ceilingTokens: 5_000, keepSteps: [6, 4], summarize: true };
const estimate = (list: readonly LlmMessage[]) => estimateMessagesTokens(list);

function conversation(steps: number): LlmMessage[] {
	const messages: LlmMessage[] = [
		{ role: "system", content: "core prompt" },
		{ role: "user", content: "Build the quarterly summary for the team." },
	];
	for (let i = 0; i < steps; i += 1) {
		messages.push(
			{ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_things", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: `c${i}`, content: `${`result ${i} `.repeat(300)}\n${refLine(`art-${i}`)}` },
		);
	}
	messages.push({ role: "user", content: "And keep the tone formal." });
	return messages;
}

const GOOD_SUMMARY = "Objective: quarterly summary for the team. Done: read 20 sources (see artifact:art-3). Decisions: formal tone. Open: write the final document.";
const okSummarizer = (): SummarizeFn => vi.fn(async () => ({ text: GOOD_SUMMARY, usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, costUsd: 0.001 } }));
const run = (messages: LlmMessage[], summarize: SummarizeFn, extra: Partial<Parameters<typeof compactWithSummary>[0]> = {}) =>
	compactWithSummary({ messages, budget, estimate, trim: trimHistory, summarize, languageInstruction: "Reply in pt-BR.", ...extra });

describe("orçamento Padrão", () => {
	it("80% da janela com teto de 160k; alvo é metade do gatilho", () => {
		expect(STANDARD_CONTEXT_CAP_DEFAULT).toBe(160_000);
		expect(standardContextBudget(200_000, {})).toMatchObject({ ceilingTokens: 160_000, targetTokens: 80_000, summarize: true });
		expect(standardContextBudget(128_000, {})).toMatchObject({ ceilingTokens: 102_400, targetTokens: 51_200 });
		expect(standardContextBudget(32_000, {}).ceilingTokens).toBe(25_600);
	});
	it("teto limita janelas gigantes e vem do env quando configurado", () => {
		expect(standardContextBudget(1_000_000, {}).ceilingTokens).toBe(160_000);
		expect(standardContextBudget(1_000_000, { CONTEXT_STANDARD_MAX_TOKENS: "300000" }).ceilingTokens).toBe(300_000);
		expect(standardContextBudget(1_000_000, { CONTEXT_STANDARD_MAX_TOKENS: "abc" }).ceilingTokens).toBe(160_000);
		expect(standardContextBudget(1_000_000, { CONTEXT_STANDARD_WINDOW_FRACTION: "0.1" }).ceilingTokens).toBe(100_000);
	});
	it("janela desconhecida cai em 128k; janela minúscula nunca fica abaixo do teto do Econômico", () => {
		expect(standardContextBudget(null, {}).ceilingTokens).toBe(102_400);
		expect(standardContextBudget(undefined, {}).ceilingTokens).toBe(102_400);
		expect(standardContextBudget(0, {}).ceilingTokens).toBe(102_400);
		expect(standardContextBudget(8_000, {}).ceilingTokens).toBe(20_000);
	});
	it("a escolha da conta decide: economy = 12k/20k sem resumo; ausente = Padrão", () => {
		expect(contextBudgetFor("economy", 200_000, {})).toEqual(contextBudgetFromEnv({}));
		expect(contextBudgetFor("economy", 200_000, {}).summarize).toBeUndefined();
		expect(contextBudgetFor("standard", 200_000, {}).summarize).toBe(true);
		expect(contextBudgetFor(undefined, 200_000, {}).ceilingTokens).toBe(160_000);
	});
});

describe("compactação por resumo", () => {
	it("dentro do orçamento: nada acontece e o modelo não é chamado", async () => {
		const summarize = okSummarizer();
		const result = await run(conversation(1), summarize);
		expect(result.status).toBe("skipped");
		expect(summarize).not.toHaveBeenCalled();
	});

	it("Econômico (sem summarize) nunca chama o resumidor", async () => {
		const summarize = okSummarizer();
		const result = await run(conversation(30), summarize, { budget: { targetTokens: 3_000, ceilingTokens: 5_000 } });
		expect(result.status).toBe("skipped");
		expect(summarize).not.toHaveBeenCalled();
	});

	it("passou do teto: resume a parte antiga, mantém a recente na íntegra e as referências", async () => {
		const input = conversation(30);
		const summarize = okSummarizer();
		const result = await run(input, summarize);
		expect(result.status).toBe("summarized");
		expect(summarize).toHaveBeenCalledTimes(1);
		if (result.status !== "summarized") return;
		expect(result.usage?.costUsd).toBe(0.001);
		const note = result.messages.find((m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_NOTE_PREFIX));
		expect(note?.role).toBe("system");
		expect(String(note?.content)).toContain(GOOD_SUMMARY);
		// Referências dos resultados que saíram ficam na nota mesmo que o modelo não as cite.
		expect(String(note?.content)).toContain("artifact:art-0");
		expect(String(note?.content)).toContain("artifact:art-3");
		// A recente (última fala do usuário e os últimos passos) fica idêntica; o resto saiu.
		expect(result.messages.at(-1)).toBe(input.at(-1));
		expect(result.messages.some((m) => m.content === "Build the quarterly summary for the team.")).toBe(false);
		expect(result.after).toBeLessThan(result.before);
		expect(estimate(result.messages)).toBeLessThanOrEqual(budget.targetTokens);
		// Pares assistant/tool continuam íntegros.
		const answered = new Set(result.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
		const asked = new Set(result.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
		expect([...answered].every((id) => asked.has(id as string))).toBe(true);
	});

	it("compacta uma vez: depois do resumo não chama de novo até passar do teto outra vez", async () => {
		const summarize = okSummarizer();
		const first = await run(conversation(30), summarize);
		expect(first.status).toBe("summarized");
		const again = await run(first.messages, summarize);
		expect(again.status).toBe("skipped");
		expect(summarize).toHaveBeenCalledTimes(1);
		// Cresce de novo: o resumo anterior entra no pedido e é fundido, não empilhado.
		const grown = [...first.messages, ...conversation(30).slice(2, -1)];
		const second = await run(grown, summarize);
		expect(second.status).toBe("summarized");
		expect(summarize).toHaveBeenCalledTimes(2);
		const request = vi.mocked(summarize).mock.calls[1]![0];
		expect(request.user).toContain("<previous_summary>");
		expect(request.user).toContain(GOOD_SUMMARY);
		if (second.status !== "summarized") return;
		expect(second.messages.filter((m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_NOTE_PREFIX))).toHaveLength(1);
	});

	it("falha, prazo ou resposta vazia: devolve a lista intacta para a poda de sempre", async () => {
		const input = conversation(30);
		for (const summarize of [
			vi.fn(async () => null),
			vi.fn(async () => {
				throw new Error("boom");
			}),
			vi.fn(async () => ({ text: "   " })),
			vi.fn(async () => ({ text: "curto", usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } })),
		] as SummarizeFn[]) {
			const result = await run(input, summarize);
			expect(result.status).toBe("failed");
			expect(result.messages).toBe(input);
		}
		// O plano B: a higiene com o mesmo orçamento apara até o alvo como no Econômico.
		const fallback = applyPromptHygiene(input, { contextBudget: budget, contextLength: 1_000_000 });
		expect(fallback.report.compaction).toBeDefined();
		expect(fallback.report.estimatedTokensAfter).toBeLessThanOrEqual(budget.targetTokens);
	});

	it("o pedido leva objetivo, estado da tarefa, idioma e as referências; nunca a marca do produto", () => {
		const state = { ...createTaskState("Build the quarterly summary for the team."), blockers: ["sheet is read-only"] };
		const request = buildSummaryRequest({ old: conversation(2), taskState: state, languageInstruction: "Reply in pt-BR.", objectiveText: "x" });
		expect(request.system).toContain("Reply in pt-BR.");
		expect(request.user).toContain("Objective: Build the quarterly summary for the team.");
		expect(request.user).toContain("Blocker: sheet is read-only");
		expect(request.user).toContain("artifact:art-1");
		expect(`${request.system}${request.user}`).not.toMatch(/atlas/i);
	});

	it("entrada enorme é cortada pelo lado antigo, mantendo o recente", () => {
		const old: LlmMessage[] = Array.from({ length: 400 }, (_, i) => ({ role: "user" as const, content: `msg-${i} ${"x".repeat(1_900)}` }));
		const request = buildSummaryRequest({ old, languageInstruction: "" });
		expect(request.user).toContain("earlier messages omitted");
		expect(request.user).toContain("msg-399");
		expect(request.user).not.toContain("msg-0 ");
	});
});

describe("createStreamSummarizer", () => {
	const stream = (impl: () => Promise<unknown>) => vi.fn(impl) as never;
	it("usa o modelo de manutenção, sem ferramentas e com saída limitada; devolve texto e uso", async () => {
		const streamChat = vi.fn(async () => ({ message: { role: "assistant", content: GOOD_SUMMARY }, model: "m", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.002 } }));
		const summarize = createStreamSummarizer({ streamChat: streamChat as never, model: () => "maint/model", apiKey: "k" });
		const out = await summarize({ system: "s", user: "u" });
		expect(out?.text).toBe(GOOD_SUMMARY);
		expect(out?.usage?.costUsd).toBe(0.002);
		const call = (streamChat.mock.calls[0] as unknown as [Record<string, unknown>])[0];
		expect(call).toMatchObject({ model: "maint/model", tools: [], toolChoice: "none", maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS });
	});
	it("erro do provedor vira null", async () => {
		const summarize = createStreamSummarizer({
			streamChat: stream(async () => {
				throw new Error("402");
			}),
			model: () => "m",
			apiKey: "k",
		});
		expect(await summarize({ system: "s", user: "u" })).toBeNull();
	});
	it("provedor que ignora o sinal não segura o run: estoura o prazo e devolve null", async () => {
		const summarize = createStreamSummarizer({ streamChat: stream(() => new Promise(() => undefined)), model: () => "m", apiKey: "k", timeoutMs: 30 });
		expect(await summarize({ system: "s", user: "u" })).toBeNull();
	});
});
