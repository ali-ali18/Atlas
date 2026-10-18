import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { createTaskState, type TaskState } from "@workspace/shared";
import { applyPromptHygiene, estimateMessagesTokens } from "../hygiene.js";
import { COMPACTION_NOTE_PREFIX, CONTEXT_BUDGET_CEILING_DEFAULT, CONTEXT_BUDGET_TARGET_DEFAULT, contextBudgetFromEnv } from "./budget.js";

const budget = { targetTokens: 3_000, ceilingTokens: 5_000 };
const refLine = (id: string) => `[Full result stored as artifact:${id} (9000 chars). It stays in context for now; if it is collapsed later, re-read it with artifact_read instead of repeating the call.]`;

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
	return messages;
}

const taskState = (): TaskState => ({
	...createTaskState("Build the quarterly summary for the team."),
	artifacts: [{ kind: "file", ref: "file-1", name: "summary.pdf", step: 2 }],
	blockers: ["the sales sheet is read-only"],
});

const pairsAreIntact = (messages: LlmMessage[]) => {
	const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
	const asked = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
	return [...answered].every((id) => asked.has(id as string));
};

describe("L14: orçamento operacional de contexto", () => {
	it("padrão 12k/20k e env configurável (teto nunca abaixo do alvo)", () => {
		expect(contextBudgetFromEnv({})).toEqual({ targetTokens: CONTEXT_BUDGET_TARGET_DEFAULT, ceilingTokens: CONTEXT_BUDGET_CEILING_DEFAULT });
		expect(CONTEXT_BUDGET_TARGET_DEFAULT).toBe(12_000);
		expect(CONTEXT_BUDGET_CEILING_DEFAULT).toBe(20_000);
		expect(contextBudgetFromEnv({ ATLAS_CONTEXT_BUDGET_TARGET_TOKENS: "8000", ATLAS_CONTEXT_BUDGET_MAX_TOKENS: "9000" })).toEqual({ targetTokens: 8_000, ceilingTokens: 9_000 });
		expect(contextBudgetFromEnv({ ATLAS_CONTEXT_BUDGET_TARGET_TOKENS: "30000" }).ceilingTokens).toBe(30_000);
		expect(contextBudgetFromEnv({ ATLAS_CONTEXT_BUDGET_TARGET_TOKENS: "x" }).targetTokens).toBe(12_000);
	});

	it("dentro do teto nada muda", () => {
		const input = conversation(3);
		const out = applyPromptHygiene(input, { contextBudget: { targetTokens: 12_000, ceilingTokens: 20_000 } }).messages;
		expect(JSON.stringify(out)).toBe(JSON.stringify(applyPromptHygiene(input).messages));
		expect(out.some((m) => String(m.content).startsWith(COMPACTION_NOTE_PREFIX))).toBe(false);
	});

	it("acima do teto compacta até o alvo preservando objetivo, entregas, bloqueios e referências", () => {
		const input = conversation(40);
		const before = estimateMessagesTokens(applyPromptHygiene(input).messages);
		expect(before).toBeGreaterThan(budget.ceilingTokens);
		const out = applyPromptHygiene(input, { contextBudget: budget, taskState, objectiveText: "fallback" }).messages;
		expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(budget.targetTokens * 1.1);
		expect(estimateMessagesTokens(out)).toBeLessThan(before / 2);
		const note = out.find((m) => String(m.content).startsWith(COMPACTION_NOTE_PREFIX));
		const text = String(note?.content);
		expect(text).toContain("Objective: Build the quarterly summary for the team.");
		expect(text).toContain("Already delivered: file summary.pdf");
		expect(text).toContain("Blocker: the sales sheet is read-only");
		expect(text).toContain("artifact:art-");
		expect(text).toContain("artifact_read");
		// Antes da conversa, depois do prompt; pares assistant/tool íntegros; a cauda recente segue.
		expect(out[0]!.content).toBe("core prompt");
		expect(out[1]).toBe(note);
		expect(pairsAreIntact(out)).toBe(true);
		expect(JSON.stringify(out)).toContain("result 39");
	});

	it("sem estado persistido usa o objetivo recebido", () => {
		const out = applyPromptHygiene(conversation(40), { contextBudget: budget, objectiveText: "Fallback objective" }).messages;
		expect(String(out.find((m) => String(m.content).startsWith(COMPACTION_NOTE_PREFIX))?.content)).toContain("Objective: Fallback objective");
	});

	it("é idempotente: reaplicar não duplica a nota nem compacta de novo", () => {
		const once = applyPromptHygiene(conversation(40), { contextBudget: budget, taskState }).messages;
		const twice = applyPromptHygiene(once, { contextBudget: budget, taskState }).messages;
		expect(twice.filter((m) => String(m.content).startsWith(COMPACTION_NOTE_PREFIX))).toHaveLength(1);
		expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
	});

	it("compacta uma vez e deixa folga: os próximos passos não reescrevem o prefixo a cada passo", () => {
		let messages = applyPromptHygiene(conversation(40), { contextBudget: budget, taskState }).messages;
		const baseline = JSON.stringify(messages.slice(0, 2));
		let rewrites = 0;
		for (let i = 0; i < 4; i += 1) {
			messages = [
				...messages,
				{ role: "assistant", content: null, tool_calls: [{ id: `n${i}`, type: "function", function: { name: "read_things", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: `n${i}`, content: `new ${i} `.repeat(100) },
			];
			messages = applyPromptHygiene(messages, { contextBudget: budget, taskState }).messages;
			if (JSON.stringify(messages.slice(0, 2)) !== baseline) rewrites += 1;
		}
		expect(rewrites).toBe(0);
	});
});

describe("fase 4: orçamento para runs de código", () => {
	it("compacta em 80% da janela do modelo; janela desconhecida = 128k; teto absoluto opcional", async () => {
		const { devContextBudget } = await import("./budget.js");
		expect(devContextBudget(128_000, {})).toMatchObject({ ceilingTokens: 102_400, targetTokens: 61_440 });
		expect(devContextBudget(200_000, {}).ceilingTokens).toBe(160_000);
		expect(devContextBudget(1_000_000, {}).ceilingTokens).toBe(800_000);
		expect(devContextBudget(null, {}).ceilingTokens).toBe(102_400);
		expect(devContextBudget(1_000_000, { DEV_CONTEXT_BUDGET_TOKENS: "150000" }).ceilingTokens).toBe(150_000);
		expect(devContextBudget(100_000, { DEV_CONTEXT_BUDGET_TOKENS: "150000" }).ceilingTokens).toBe(80_000);
		expect(devContextBudget(200_000, { DEV_CONTEXT_WINDOW_FRACTION: "0.5" }).ceilingTokens).toBe(100_000);
		expect(devContextBudget(32_000, {}).ceilingTokens).toBe(25_600);
		// runs que não são de código seguem o orçamento de sempre
		expect(contextBudgetFromEnv({})).toEqual({ targetTokens: 12_000, ceilingTokens: 20_000 });
	});

	it("não compacta dentro do teto de código, mas compacta no de navegador", () => {
		const input = conversation(40);
		const coding = { targetTokens: 40_000, ceilingTokens: 70_000, keepSteps: [60, 40, 24, 12, 6] };
		expect(applyPromptHygiene(input, { contextBudget: coding, contextLength: 1_000_000 }).report.compaction).toBeUndefined();
		const browser = applyPromptHygiene(input, { contextBudget: { targetTokens: 3_000, ceilingTokens: 5_000 }, contextLength: 1_000_000 });
		expect(browser.report.compaction).toBeDefined();
		expect(browser.report.compaction!.after).toBeLessThan(browser.report.compaction!.before);
	});

	it("a nota de um run de código guarda tarefas, arquivos, falhas e decisões", () => {
		const input = conversation(40);
		input.splice(4, 0, { role: "assistant", content: "Decidi usar o hook useDebounce em vez de lodash para evitar dependência nova." });
		const out = applyPromptHygiene(input, {
			contextBudget: { targetTokens: 2_000, ceilingTokens: 3_000, keepSteps: [6, 4] },
			contextLength: 1_000_000,
			codingContext: () => ({
				todos: [{ id: "1", content: "Corrigir testes do painel", status: "in_progress" }],
				filesChanged: [{ path: "/workspace/app/panel.tsx", added: 4, removed: 1 }],
				failures: [{ cmd: "pnpm test", exitCode: 1, tail: "FAIL panel.test.tsx expected 2 got 3" }],
			}),
		});
		const note = out.messages.find((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_NOTE_PREFIX))!;
		const text = String(note.content);
		expect(text).toContain("[in_progress] Corrigir testes do painel");
		expect(text).toContain("/workspace/app/panel.tsx (+4 -1)");
		expect(text).toContain("pnpm test");
		expect(text).toContain("expected 2 got 3");
		expect(text).toContain("useDebounce");
		expect(out.report.compaction).toBeDefined();
	});
});
