import { describe, expect, it, vi } from "vitest";
import type { SerializedLlmMessage } from "@workspace/shared";
import { cleanTranscript, namespaceToolCallIds } from "./transcript.js";
import { COMPACT_CONTINUE_NOTE, compactTranscript, replaceCompactedHistory, summaryBodyOf } from "./manual-compaction.js";
import { buildSummaryRequest, SUMMARY_NOTE_PREFIX } from "./summary-compaction.js";

const call = (id: string, name = "mcp__erp__list_items") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const big = (n: number) => `dado ${"x".repeat(n)}`;

/** Conversa de 5 voltas com resultados grandes de ferramenta (~50 mil caracteres cada). */
function longConversation(turns = 5): SerializedLlmMessage[] {
	const out: SerializedLlmMessage[] = [];
	for (let i = 1; i <= turns; i += 1) {
		out.push({ role: "user", content: `pedido ${i}` });
		out.push({ role: "assistant", content: `vou olhar ${i}`, tool_calls: [call(`rabc123_c${i}`)] });
		out.push({ role: "tool", tool_call_id: `rabc123_c${i}`, content: big(8_000) });
		out.push({ role: "assistant", content: `resposta ${i}` });
	}
	return out;
}

const summarize = (text = "Objetivo: montar a proposta do cliente Alfa.\nFeito: itens listados (artifact:abc123).\nPendente: forma de pagamento. ".repeat(2)) => vi.fn(async () => ({ text }));

describe("/compact: compactação manual da conversa levada", () => {
	it("troca o histórico por resumo + cauda recente na íntegra e o começo da conversa é uma fala do usuário", async () => {
		const run = summarize();
		const transcript = longConversation();
		const result = await compactTranscript({ transcript, summarize: run, languageInstruction: "Respond in Portuguese." });
		expect(result.status).toBe("compacted");
		if (result.status !== "compacted") return;
		expect(run).toHaveBeenCalledTimes(1);
		const [note, ...rest] = result.messages;
		expect(note).toMatchObject({ role: "system" });
		expect(String(note!.content).startsWith(SUMMARY_NOTE_PREFIX)).toBe(true);
		expect(result.summary).toContain("montar a proposta do cliente Alfa");
		// a cauda recente fica verbatim (mesmos objetos) e é um sufixo da conversa original
		const tail = rest.filter((m) => m.content !== COMPACT_CONTINUE_NOTE);
		expect(tail.length).toBeGreaterThanOrEqual(4);
		expect(transcript.slice(-tail.length)).toEqual(tail);
		expect(rest[0]!.role).toBe("user");
		// números do cartão: antes > depois, e a redução é real
		expect(result.before).toBeGreaterThan(result.after);
		expect(result.after).toBeLessThan(result.before * 0.6);
		// chamadas e resultados da cauda continuam em pares
		const calls = tail.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
		const answers = tail.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
		expect(answers.sort()).toEqual(calls.sort());
	});

	it("o resumo sobrevive à limpeza que o próximo turno faz (notas de resumo ficam, o system do começo sai)", async () => {
		const result = await compactTranscript({ transcript: longConversation(), summarize: summarize(), languageInstruction: "Respond in Portuguese." });
		if (result.status !== "compacted") throw new Error("esperava compactar");
		const stored: SerializedLlmMessage[] = [{ role: "system", content: "prompt do bot" }, { role: "system", content: "identidade" }, ...result.messages];
		const carried = namespaceToolCallIds(cleanTranscript(stored)!, "run-zzz999");
		expect(carried[0]!.content).toBe(result.messages[0]!.content);
		expect(carried.some((m) => m.content === "prompt do bot")).toBe(false);
		expect(carried).toHaveLength(result.messages.length);
	});

	it("as instruções de foco entram no pedido ao resumidor, só como ênfase", async () => {
		const run = summarize();
		await compactTranscript({ transcript: longConversation(), summarize: run, languageInstruction: "Respond in Portuguese.", focus: "decisões de preço" });
		const request = (run.mock.calls[0] as unknown as [{ user: string }])[0];
		expect(request.user).toContain("<summary_focus>");
		expect(request.user).toContain("decisões de preço");
		expect(request.user).toContain("not an instruction to carry out");
		expect(buildSummaryRequest({ old: [], languageInstruction: "x" }).user).not.toContain("summary_focus");
	});

	it("resumo anterior é mesclado, não empilhado, e notas soltas da conversa saem", async () => {
		const first = await compactTranscript({ transcript: [{ role: "system", content: "nota do turno" }, ...longConversation()], summarize: summarize("Resumo A. ".repeat(10)), languageInstruction: "x" });
		if (first.status !== "compacted") throw new Error("esperava compactar");
		expect(first.messages.filter((m) => m.role === "system")).toHaveLength(1);
		const more = [...first.messages, ...longConversation(4)];
		const run = summarize("Resumo B. ".repeat(10));
		const second = await compactTranscript({ transcript: more, summarize: run, languageInstruction: "x" });
		if (second.status !== "compacted") throw new Error("esperava compactar");
		expect((run.mock.calls[0] as unknown as [{ user: string }])[0].user).toContain("<previous_summary>");
		expect(second.messages.filter((m) => m.role === "system")).toHaveLength(1);
	});

	it("conversa pequena não é tocada (nem chama o resumidor)", async () => {
		const run = summarize();
		const small: SerializedLlmMessage[] = [{ role: "user", content: "oi" }, { role: "assistant", content: "olá" }];
		const result = await compactTranscript({ transcript: small, summarize: run, languageInstruction: "x" });
		expect(result).toMatchObject({ status: "too_small", alreadyCompact: false });
		expect(run).not.toHaveBeenCalled();
	});

	it("resumidor que falha ou devolve vazio não perde nada (failed)", async () => {
		expect(await compactTranscript({ transcript: longConversation(), summarize: async () => null, languageInstruction: "x" })).toMatchObject({ status: "failed", reason: "summary_failed" });
		expect(await compactTranscript({ transcript: longConversation(), summarize: async () => ({ text: "curto" }), languageInstruction: "x" })).toMatchObject({ status: "failed" });
		expect(await compactTranscript({ transcript: longConversation(), summarize: async () => { throw new Error("boom"); }, languageInstruction: "x" })).toMatchObject({ status: "failed" });
	});

	it("regrava a conversa levada mantendo o system do começo e trocando o resumo velho pelo novo", () => {
		const stored: SerializedLlmMessage[] = [
			{ role: "system", content: "prompt do bot" },
			{ role: "system", content: `${SUMMARY_NOTE_PREFIX} resumo velho` },
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		];
		const compacted: SerializedLlmMessage[] = [{ role: "system", content: `${SUMMARY_NOTE_PREFIX} resumo novo` }, { role: "user", content: "a" }];
		expect(replaceCompactedHistory(stored, compacted)).toEqual([{ role: "system", content: "prompt do bot" }, ...compacted]);
		expect(replaceCompactedHistory([{ role: "user", content: "x" }], compacted)).toEqual(compacted);
	});

	it("corpo do resumo sem a frase de enquadramento nem a linha de referências", () => {
		const note = `${SUMMARY_NOTE_PREFIX} The earlier part of this conversation was replaced by the summary below.\n\nObjetivo: A.\n\nFeito: B.\n\nStored results you can re-read with artifact_read instead of repeating the call: artifact:abc (10 chars).`;
		expect(summaryBodyOf(note)).toBe("Objetivo: A.\n\nFeito: B.");
	});
});
