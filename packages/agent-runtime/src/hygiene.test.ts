import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import { BudgetExhaustedError } from "./errors.js";
import {
	COLLAPSE_MARKER,
	STUB_LAST_GROUP_MAX_CHARS,
	STUB_TOOL_OUTPUT_MAX_CHARS,
	applyPromptHygiene,
	collapseOldToolGroups,
	estimateMessagesTokens,
	stubLargeToolOutputs,
} from "./hygiene.js";

function toolMsg(id: string, content: string): LlmMessage {
	return { role: "tool", tool_call_id: id, content };
}

function assistantWithCalls(
	calls: Array<{ id: string; name: string }>,
): LlmMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: calls.map((call) => ({
			id: call.id,
			type: "function" as const,
			function: { name: call.name, arguments: "{}" },
		})),
	};
}

describe("estimateMessagesTokens", () => {
	it("retorna 0 para conversa vazia sem tools", () => {
		expect(estimateMessagesTokens([], 0)).toBe(0);
	});

	it("soma texto + tools", () => {
		const base = estimateMessagesTokens([{ role: "user", content: "oi" }], 0);
		const withTools = estimateMessagesTokens(
			[{ role: "user", content: "oi" }],
			320,
		);
		expect(withTools).toBeGreaterThan(base);
	});
});

describe("collapseOldToolGroups", () => {
	it("mantém tudo quando há 1 grupo ou nenhum", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "vai" },
		];
		const { messages: out, collapsedGroups } = collapseOldToolGroups(messages);
		expect(out).toEqual(messages);
		expect(collapsedGroups).toBe(0);
	});

	it("condensa grupos antigos por id e preserva o último íntegro", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			assistantWithCalls([
				{ id: "c1", name: "browser_text" },
				{ id: "c2", name: "browser_links" },
			]),
			toolMsg("c1", "texto antigo bem longo ".repeat(20)),
			toolMsg("c2", "mais texto antigo ".repeat(20)),
			assistantWithCalls([{ id: "c3", name: "click" }]),
			toolMsg("c3", "resultado recente"),
		];
		const { messages: out, collapsedGroups } = collapseOldToolGroups(messages);
		expect(collapsedGroups).toBe(1);
		// Grupo antigo vira 1 msg por id (nunca funde num id único).
		expect(out).toHaveLength(6);
		expect(out[2]?.content).toContain(COLLAPSE_MARKER);
		expect(out[2]?.content).toContain("browser_text");
		expect(out[2]?.tool_call_id).toBe("c1");
		expect(out[3]?.content).toContain(COLLAPSE_MARKER);
		expect(out[3]?.content).toContain("browser_links");
		expect(out[3]?.tool_call_id).toBe("c2");
		expect(out[5]).toEqual(toolMsg("c3", "resultado recente"));
	});

	it("preserva os 3 ids de chamadas paralelas (sem fundir)", () => {
		const messages: LlmMessage[] = [
			assistantWithCalls([
				{ id: "p1", name: "web_extract" },
				{ id: "p2", name: "web_extract" },
				{ id: "p3", name: "browser_text" },
			]),
			toolMsg("p1", "saída um ".repeat(50)),
			toolMsg("p2", "saída dois ".repeat(50)),
			toolMsg("p3", "saída três ".repeat(50)),
			assistantWithCalls([{ id: "p4", name: "click" }]),
			toolMsg("p4", "recente"),
		];
		const { messages: out, collapsedGroups } = collapseOldToolGroups(messages);
		expect(collapsedGroups).toBe(1);
		const collapsed = out.filter(
			(m) =>
				m.role === "tool" &&
				typeof m.content === "string" &&
				m.content.startsWith(COLLAPSE_MARKER),
		);
		expect(collapsed.map((m) => m.tool_call_id).sort()).toEqual([
			"p1",
			"p2",
			"p3",
		]);
		// Toda chamada do assistant continua com resposta correspondente.
		for (const id of ["p1", "p2", "p3"]) {
			expect(out.some((m) => m.role === "tool" && m.tool_call_id === id)).toBe(
				true,
			);
		}
		expect(out[out.length - 1]).toEqual(toolMsg("p4", "recente"));
	});

	it("condensa textos do mesmo id com ' | ' (cap 200 cada, trecho cap 300)", () => {
		const messages: LlmMessage[] = [
			assistantWithCalls([{ id: "d1", name: "web_extract" }]),
			toolMsg("d1", `primeira parte ${"a".repeat(500)}`),
			toolMsg("d1", `segunda parte ${"b".repeat(500)}`),
			assistantWithCalls([{ id: "d2", name: "click" }]),
			toolMsg("d2", "recente"),
		];
		const { messages: out } = collapseOldToolGroups(messages);
		const collapsed = out.find((m) => m.tool_call_id === "d1");
		expect(collapsed?.content).toContain(COLLAPSE_MARKER);
		expect(collapsed?.content).toContain(" | ");
		expect(collapsed?.content).toContain("primeira parte");
		expect(collapsed?.content).toContain("segunda parte");
	});

	it("não re-colapsa grupo já marcado (idempotente)", () => {
		const marked: LlmMessage = {
			role: "tool",
			tool_call_id: "c0",
			content: `${COLLAPSE_MARKER}: click (1 resultado(s) antigos).`,
		};
		const messages: LlmMessage[] = [
			{ role: "user", content: "oi" },
			marked,
			assistantWithCalls([{ id: "c1", name: "click" }]),
			toolMsg("c1", "novo"),
		];
		const { messages: out, collapsedGroups } = collapseOldToolGroups(messages);
		expect(collapsedGroups).toBe(0);
		expect(out).toEqual(messages);
	});
});

describe("stubLargeToolOutputs", () => {
	it("espreme saída gigante (inclusive último grupo) com marcador", () => {
		const big = "conteúdo do extract ".repeat(3000);
		const messages: LlmMessage[] = [
			{ role: "user", content: "vai" },
			assistantWithCalls([{ id: "e1", name: "web_extract" }]),
			toolMsg("e1", big),
		];
		const out = stubLargeToolOutputs(messages);
		expect(out).toHaveLength(messages.length);
		const stubbed = out[2]!;
		expect(typeof stubbed.content).toBe("string");
		expect((stubbed.content as string).length).toBeLessThan(big.length);
		expect(stubbed.content).toContain("[truncado:");
		expect(stubbed.tool_call_id).toBe("e1");
	});

	it("último grupo (ainda não lido) usa teto maior que os antigos", () => {
		const medium = "m".repeat(STUB_TOOL_OUTPUT_MAX_CHARS + 4000);
		const messages: LlmMessage[] = [
			assistantWithCalls([{ id: "old", name: "web_extract" }]),
			toolMsg("old", medium),
			assistantWithCalls([
				{ id: "new1", name: "web_extract" },
				{ id: "new2", name: "browser_text" },
			]),
			toolMsg("new1", medium),
			toolMsg("new2", "x".repeat(STUB_LAST_GROUP_MAX_CHARS + 10)),
		];
		const out = stubLargeToolOutputs(messages);
		expect(out[1]?.content).toContain("[truncado:");
		expect(out[3]?.content).toBe(medium);
		expect(out[4]?.content).toContain("[truncado:");
		expect((out[4]?.content as string).startsWith("x".repeat(STUB_LAST_GROUP_MAX_CHARS))).toBe(true);
	});

	it("não toca em saída pequena nem em conteúdo não-string", () => {
		const messages: LlmMessage[] = [
			toolMsg("c1", "curto"),
			{ role: "user", content: "x".repeat(9000) },
			{ role: "tool", tool_call_id: "c2", content: null },
		];
		expect(stubLargeToolOutputs(messages)).toEqual(messages);
	});

	it("é idempotente (não re-corta stub)", () => {
		const messages: LlmMessage[] = [
			toolMsg("c1", "y".repeat(20_000)),
		];
		const once = stubLargeToolOutputs(messages);
		expect(stubLargeToolOutputs(once)).toEqual(once);
	});
});

describe("applyPromptHygiene", () => {
	it("não toca em conversa pequena (guard none)", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "oi, tudo bem?" },
		];
		const { messages: out, report } = applyPromptHygiene(messages, {
			contextLength: 128_000,
		});
		expect(out).toEqual(messages);
		expect(report.guard).toBe("none");
		expect(report.collapsedGroups).toBe(0);
	});

	it("apara histórico no soft preservando systems", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			...Array.from({ length: 30 }, (_, i) => ({
				role: (i % 2 === 0 ? "user" : "assistant") as LlmMessage["role"],
				content: `mensagem ${i} `.repeat(50),
			})),
		];
		const { messages: out, report } = applyPromptHygiene(messages, {
			// Janela pequena de propósito para forçar o soft.
			contextLength: 2_000,
			softKeep: 4,
			hardKeep: 2,
		});
		expect(report.guard).toBe("soft");
		expect(out[0]).toEqual({ role: "system", content: "sys" });
		expect(out.length).toBeLessThan(messages.length);
	});

	it("sem bloco de skills: mensagem system com esse texto não recebe tratamento especial", () => {
		const block = `UNTRUSTED PROCEDURE DATA. ${"x".repeat(3000)}`;
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "system", content: block },
			...Array.from({ length: 6 }, (_, i) => ({
				role: "user" as const,
				content: `pergunta ${i} `.repeat(40),
			})),
		];
		const { messages: out, report } = applyPromptHygiene(messages, {
			contextLength: 2_000,
			softKeep: 8,
			hardKeep: 4,
		});
		expect(report.guard).not.toBe("none");
		expect("droppedSkills" in report).toBe(false);
		expect(out.find((m) => m.content === block)).toBeDefined();
	});

	it("extract de 60k no último grupo vira stub (sem BudgetExhaustedError)", () => {
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "extrai tudo" },
			assistantWithCalls([{ id: "big1", name: "web_extract" }]),
			toolMsg("big1", "dado ".repeat(12_000)),
		];
		expect(messages[3]?.content).toHaveLength(60_000);
		const { messages: out, report } = applyPromptHygiene(messages, {
			// ~32640 chars no hard: cru estouraria, espremido (24k) cabe.
			contextLength: 12_000,
		});
		expect(report.guard).not.toBe("hard");
		const last = out[out.length - 1]!;
		expect(last.role).toBe("tool");
		expect(last.tool_call_id).toBe("big1");
		expect(last.content).toContain("[truncado:");
		expect((last.content as string).length).toBeLessThan(
			STUB_LAST_GROUP_MAX_CHARS + 100,
		);
	});

	it("trim nunca gera par órfão (tool sem pai, ou calls sem resposta)", () => {
		const turn = (id: string, filler: string): LlmMessage[] => [
			{ role: "user", content: `pergunta ${id} ${filler}` },
			assistantWithCalls([{ id: `${id}-call`, name: "click" }]),
			toolMsg(`${id}-call`, `resultado ${id} ${filler}`),
		];
		const messages: LlmMessage[] = [
			{ role: "system", content: "sys" },
			...turn("a", "x".repeat(300)),
			...turn("b", "y".repeat(300)),
			...turn("c", "z".repeat(300)),
			...turn("d", "w".repeat(300)),
		];
		const { messages: out } = applyPromptHygiene(messages, {
			contextLength: 1_500,
			softKeep: 3,
			hardKeep: 3,
		});
		// Toda tool tem o assistant com tool_calls correspondente presente.
		const callIds = new Set<string>();
		for (const m of out) {
			for (const call of m.tool_calls ?? []) callIds.add(call.id);
		}
		for (const m of out) {
			if (m.role !== "tool" || !m.tool_call_id) continue;
			if (
				typeof m.content === "string" &&
				m.content.startsWith(COLLAPSE_MARKER)
			) {
				continue;
			}
			expect(callIds.has(m.tool_call_id)).toBe(true);
		}
		// Todo assistant com tool_calls tem todas as respostas presentes.
		const toolIds = new Set(
			out
				.filter((m) => m.role === "tool" && m.tool_call_id)
				.map((m) => m.tool_call_id as string),
		);
		for (const m of out) {
			if (m.role !== "assistant" || !m.tool_calls?.length) continue;
			for (const call of m.tool_calls) {
				expect(toolIds.has(call.id)).toBe(true);
			}
		}
		// A cauda não começa no meio de um turno (sem tool órfã na borda).
		const firstNonSystem = out.find((m) => m.role !== "system");
		expect(firstNonSystem?.role).not.toBe("tool");
	});
	it("bloqueia com erro claro quando nem a poda forte cabe", () => {
		const messages: LlmMessage[] = [
			{ role: "user", content: "x".repeat(10_000) },
		];
		expect(() =>
			applyPromptHygiene(messages, { contextLength: 100 }),
		).toThrow(BudgetExhaustedError);
	});
});

it("reasoning opaco conta na janela e é podado com seu turno, sem separar os pares", () => {
	const old: LlmMessage = { ...assistantWithCalls([{ id: "old", name: "read" }]), providerItems: { provider: "chatgpt", model: "chatgpt/luna", items: [{ type: "reasoning", encrypted_content: "x".repeat(8000) }] } };
	expect(estimateMessagesTokens([old])).toBeGreaterThan(estimateMessagesTokens([{ ...old, providerItems: undefined }]));
	const recent = assistantWithCalls([{ id: "recent", name: "read" }]);
	const messages = [old, toolMsg("old", "result"), recent, toolMsg("recent", "result")];
	const collapsed = collapseOldToolGroups(messages).messages;
	expect(collapsed[0]?.providerItems).toBe(old.providerItems);
	const trimmed = applyPromptHygiene(messages, { contextLength: 4000, softKeep: 2, hardKeep: 2 }).messages;
	expect(trimmed).toEqual([recent, toolMsg("recent", "result")]);
	expect(trimmed.every((message) => !message.providerItems)).toBe(true);
});
