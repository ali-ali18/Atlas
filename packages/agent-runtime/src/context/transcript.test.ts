import { describe, expect, it } from "vitest";
import type { LlmMessage } from "@workspace/llm";
import type { SerializedLlmMessage } from "@workspace/shared";
import { applyPromptHygiene, COLLAPSE_MARKER } from "../hygiene.js";
import { contextTranscriptEnabled } from "./flag.js";
import {
	UNEXECUTED_CALL_RESULT,
	buildTranscriptHistory,
	watermarkDivergence,
	attachPendingResult,
	calledToolNames,
	cleanTranscript,
	namespaceToolCallId,
	namespaceToolCallIds,
} from "./transcript.js";
import { CARRIED_NOTE_MAX_IDLE_TURNS, mergeCarriedNotes } from "./carried-notes.js";
import { SUMMARY_NOTE_PREFIX } from "./summary-compaction.js";

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

/** Run 1: usuário pede, o bot busca o cliente e responde (resposta final só no banco). */
const run1: SerializedLlmMessage[] = [
	{ role: "system", content: "identidade + memória" },
	{ role: "user", content: "monte uma proposta para o cliente Alfa" },
	{ role: "assistant", content: "Vou buscar.", tool_calls: [call("c1", "mcp__erp__find_client")] },
	{ role: "tool", tool_call_id: "c1", content: '{"id":42,"name":"Alfa"}' },
];

describe("cleanTranscript", () => {
	it("tira só o system do começo, mantém notas de resumo, notas depois da primeira fala (na posição enviada) e os resultados", () => {
		const cleaned = cleanTranscript([
			{ role: "system", content: "camada" },
			{ role: "system", content: `${SUMMARY_NOTE_PREFIX} resumo` },
			...run1.slice(1),
			{ role: "system", content: "nota do turno" },
		])!;
		expect(cleaned.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "system"]);
		expect(cleaned[4]!.content).toBe("nota do turno");
		expect(cleaned[0]!.content).toContain(SUMMARY_NOTE_PREFIX);
		expect(cleaned[3]!.content).toContain("Alfa");
	});

	it("nota de sistema no meio da rodada espera o fim dela e os resultados continuam colados à chamada", () => {
		const cleaned = cleanTranscript([
			{ role: "user", content: "x" },
			{ role: "system", content: "nota do turno" },
			{ role: "assistant", content: null, tool_calls: [call("a", "t1"), call("b", "t2")] },
			{ role: "tool", tool_call_id: "a", content: "ra" },
			{ role: "system", content: "aviso" },
			{ role: "tool", tool_call_id: "b", content: "rb" },
		])!;
		expect(cleaned.map((m) => m.content)).toEqual(["x", "nota do turno", null, "ra", "rb", "aviso"]);
	});

	it("dá resposta a chamada sem resultado e descarta resultado órfão", () => {
		const cleaned = cleanTranscript([
			{ role: "user", content: "x" },
			{ role: "tool", tool_call_id: "orfao", content: "?" },
			{ role: "assistant", content: null, tool_calls: [call("a", "t1"), call("b", "t2")] },
			{ role: "tool", tool_call_id: "a", content: "ok" },
		])!;
		expect(cleaned.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
		expect(cleaned[3]).toMatchObject({ tool_call_id: "b", content: UNEXECUTED_CALL_RESULT });
	});

	it("gravação corrompida ou vazia vira null", () => {
		expect(cleanTranscript(undefined)).toBeNull();
		expect(cleanTranscript([])).toBeNull();
		expect(cleanTranscript([{ role: "robot", content: "x" }])).toBeNull();
		expect(cleanTranscript([{ role: "tool", content: "sem id" }])).toBeNull();
		expect(cleanTranscript([{ role: "system", content: "só camada" }])).toBeNull();
	});

	it("providerItems só ficam com o mesmo modelo", () => {
		const items = { provider: "chatgpt" as const, model: "m1", items: [{ type: "message" }] };
		const raw = [{ role: "user", content: "oi" }, { role: "assistant", content: "ola", providerItems: items }];
		expect(cleanTranscript(raw, { model: "m1" })![1]!.providerItems).toBeDefined();
		expect(cleanTranscript(raw, { model: "m2" })![1]!.providerItems).toBeUndefined();
	});
});

describe("buildTranscriptHistory (por id, sem comparar texto)", () => {
	const cleaned = cleanTranscript(run1)!;

	it("o turno 2 enxerga o resultado de ferramenta do turno 1 e as falas depois da marca, em ordem", () => {
		const out = buildTranscriptHistory({
			transcript: cleaned,
			after: [
				{ role: "assistant", content: "fala de outro autor" },
				{ role: "user", content: "[card] confirmado: Criar?" },
				{ role: "user", content: "30 dias" },
			],
			objective: "30 dias",
		});
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(out[2]!.content).toContain('"id":42');
		expect(out[4]!.content).toContain("confirmado");
	});

	it("falas em vários balões e cartão reescrito não impedem a conversa: nada é comparado por texto", () => {
		const out = buildTranscriptHistory({
			transcript: cleaned,
			after: [{ role: "user", content: "novo pedido" }],
			objective: "novo pedido",
		});
		expect(out).toHaveLength(cleaned.length);
		expect(out.some((m) => m.role === "tool")).toBe(true);
	});

	it("fala do usuário enviada durante o run (já absorvida por ele) não entra de novo; depois do fim do run, entra", () => {
		const joined = cleanTranscript([...run1, { role: "user", content: "e inclua o frete" }])!;
		const out = buildTranscriptHistory({
			transcript: joined,
			after: [
				{ role: "user", content: "e inclua o frete", createdAt: "2026-01-01T10:00:00.000Z" },
				{ role: "user", content: "e inclua o frete", createdAt: "2026-01-01T12:00:00.000Z" },
				{ role: "user", content: "fim" },
			],
			objective: "fim",
			priorRunEndedAt: "2026-01-01T11:00:00.000Z",
		});
		expect(out.filter((m) => m.role === "user" && m.content === "e inclua o frete")).toHaveLength(2);
	});
});

describe("watermarkDivergence", () => {
	it("mensagem da marca apagada: diverge", () => {
		expect(watermarkDivergence({ count: 10 }, { exists: false, countUpTo: 0 })).toBe("watermark_missing");
	});
	it("menos mensagens até a marca do que havia (apagada antes dela): diverge", () => {
		expect(watermarkDivergence({ count: 10 }, { exists: true, countUpTo: 9 })).toBe("history_shrunk");
	});
	it("checkpoint sem marca (legado): diverge", () => {
		expect(watermarkDivergence(undefined, { exists: true, countUpTo: 10 })).toBe("no_watermark");
	});
	it("mesma contagem ou mais: a conversa gravada vale", () => {
		expect(watermarkDivergence({ count: 10 }, { exists: true, countUpTo: 10 })).toBeNull();
		expect(watermarkDivergence({ count: 10 }, { exists: true, countUpTo: 11 })).toBeNull();
	});
});

describe("attachPendingResult", () => {
	const asked: SerializedLlmMessage[] = [
		{ role: "user", content: "crie a proposta" },
		{ role: "assistant", content: "Vou criar.", tool_calls: [call("p1", "mcp__erp__create_proposal")] },
		{ role: "tool", tool_call_id: "p1", content: "Card de confirmação enviado. Nada foi executado ainda." },
	];

	it("o resultado executado vira o resultado da mesma chamada pendente", () => {
		const out = attachPendingResult(asked, "mcp__erp__create_proposal", "proposta 777 criada")!;
		expect(out).toHaveLength(3);
		expect(out[2]).toMatchObject({ role: "tool", tool_call_id: "p1", content: "proposta 777 criada" });
		expect(asked[2]!.content).toContain("Card de confirmação");
	});

	it("chamada ausente: null", () => {
		expect(attachPendingResult(asked, "mcp__erp__other", "x")).toBeNull();
	});
});

describe("calledToolNames e kill switch", () => {
	it("lista as tools chamadas", () => {
		expect(calledToolNames(run1)).toEqual(["mcp__erp__find_client"]);
	});

	it("ATLAS_CONTEXT_TRANSCRIPT desliga; padrão ligado", () => {
		expect(contextTranscriptEnabled({})).toBe(true);
		expect(contextTranscriptEnabled({ ATLAS_CONTEXT_TRANSCRIPT: "0" })).toBe(false);
		expect(contextTranscriptEnabled({ ATLAS_CONTEXT_TRANSCRIPT: "off" })).toBe(false);
		expect(contextTranscriptEnabled({ ATLAS_CONTEXT_TRANSCRIPT: "false" })).toBe(false);
		expect(contextTranscriptEnabled({ ATLAS_CONTEXT_TRANSCRIPT: "1" })).toBe(true);
	});
});

describe("higiene da conversa contínua", () => {
	const groups = (n: number): LlmMessage[] => {
		const out: LlmMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "pedido" }];
		for (let i = 0; i < n; i += 1) {
			out.push({ role: "assistant", content: null, tool_calls: [call(`k${i}`, "buscar")] });
			out.push({ role: "tool", tool_call_id: `k${i}`, content: `resultado ${i} ${"x".repeat(400)}` });
		}
		return out;
	};
	const isCollapsed = (m: LlmMessage) => typeof m.content === "string" && m.content.startsWith(COLLAPSE_MARKER);

	it("mantém os grupos recentes inteiros e só limpa os mais antigos", () => {
		const { messages } = applyPromptHygiene(groups(10), { keepRecentGroups: 6 });
		const tools = messages.filter((m) => m.role === "tool");
		expect(tools).toHaveLength(10);
		expect(tools.slice(0, 4).every(isCollapsed)).toBe(true);
		expect(tools.slice(4).some(isCollapsed)).toBe(false);
	});

	it("sem pressão de janela nada é limpo; com pressão, só os antigos", () => {
		const calm = applyPromptHygiene(groups(10), { keepRecentGroups: 6, collapseOverTokens: 100_000 });
		expect(calm.messages.some(isCollapsed)).toBe(false);
		const tight = applyPromptHygiene(groups(10), { keepRecentGroups: 6, collapseOverTokens: 100 });
		expect(tight.messages.filter(isCollapsed)).toHaveLength(4);
	});

	it("o par assistant/tool continua válido depois da limpeza", () => {
		const { messages } = applyPromptHygiene(groups(10), { keepRecentGroups: 3, collapseOverTokens: 100 });
		const ids = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
		for (const m of messages.filter((x) => x.role === "tool")) expect(ids.has(m.tool_call_id!)).toBe(true);
	});
});

describe("guardas por janela da conversa contínua", () => {
	const big = (n: number): LlmMessage[] => {
		const out: LlmMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "pedido" }];
		for (let i = 0; i < n; i += 1) {
			out.push({ role: "assistant", content: null, tool_calls: [call(`k${i}`, "buscar")] });
			out.push({ role: "tool", tool_call_id: `k${i}`, content: `r${i} ${"y".repeat(3_000)}` });
		}
		return out;
	};

	it("perto do limite limpa primeiro os resultados antigos e preserva as mensagens", () => {
		// ~6 grupos x 3k chars ~ 4.6k tokens; janela 6k com soft 0.75 = 4.5k
		const { messages, report } = applyPromptHygiene(big(6), { contextLength: 6_000, softRatio: 0.75, hardRatio: 0.95, keepRecentGroups: 6, collapseOverTokens: 1_000_000 });
		expect(report.guard).toBe("soft");
		expect(messages.filter((m) => m.role === "assistant")).toHaveLength(6);
		expect(messages.filter((m) => m.role === "tool").slice(0, -1).every((m) => String(m.content).startsWith(COLLAPSE_MARKER))).toBe(true);
	});

	it("abaixo do soft nada é cortado", () => {
		const { messages, report } = applyPromptHygiene(big(6), { contextLength: 20_000, softRatio: 0.75, hardRatio: 0.95, keepRecentGroups: 6, collapseOverTokens: 1_000_000 });
		expect(report.guard).toBe("none");
		expect(messages).toHaveLength(big(6).length);
	});
});

describe("ids de chamada entre runs", () => {
	const run = (id: string): SerializedLlmMessage[] => [
		{ role: "user", content: "pede" },
		{ role: "assistant", content: null, tool_calls: [call(id, "buscar")] },
		{ role: "tool", tool_call_id: id, content: `resultado ${id}` },
	];

	it("o mesmo prefixo vai na chamada e no resultado, e dois runs com call_0 não colidem", () => {
		const a = namespaceToolCallIds(run("call_0"), "run-aaaa11");
		const b = namespaceToolCallIds(run("call_0"), "run-bbbb22");
		const idA = a[1]!.tool_calls![0]!.id;
		expect(a[2]!.tool_call_id).toBe(idA);
		expect(idA).not.toBe(b[1]!.tool_calls![0]!.id);
		expect(new Set([...a, ...b].filter((m) => m.role === "tool").map((m) => m.tool_call_id)).size).toBe(2);
	});

	it("id já prefixado na criação é identidade, e os itens do provedor acompanham a renomeação", () => {
		const born = namespaceToolCallId("call_0", "run-aaaa11");
		expect(namespaceToolCallId(born, "outro-run")).toBe(born);
		const legacy: SerializedLlmMessage[] = [
			{ role: "assistant", content: null, tool_calls: [call("call_9", "t")], providerItems: { provider: "chatgpt", model: "m", items: [{ type: "reasoning" }, { type: "function_call", call_id: "call_9" }] } },
			{ role: "tool", tool_call_id: "call_9", content: "r" },
		];
		const out = namespaceToolCallIds(legacy, "run-aaaa11");
		const id = out[0]!.tool_calls![0]!.id;
		expect(id).toBe(namespaceToolCallId("call_9", "run-aaaa11"));
		expect(out[0]!.providerItems!.items[1]).toEqual({ type: "function_call", call_id: id });
		// já nascido com o prefixo: a mesma referência volta, sem copiar nada
		expect(namespaceToolCallIds(out, "run-aaaa11")).toEqual(out);
		expect(namespaceToolCallIds(out, "run-aaaa11")[0]).toBe(out[0]);
	});

	it("idempotente, limitado a 40 e só com caracteres aceitos pelos provedores", () => {
		const once = namespaceToolCallIds(run("toolu_" + "x".repeat(60)), "r1");
		const id = once[1]!.tool_calls![0]!.id;
		expect(id.length).toBeLessThanOrEqual(40);
		expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(namespaceToolCallIds(once, "outro")).toEqual(once);
	});

	it("a chamada pendente continua achável depois do prefixo (por nome e pela cauda)", () => {
		const asked: SerializedLlmMessage[] = [
			{ role: "user", content: "crie" },
			{ role: "assistant", content: null, tool_calls: [call("call_0", "mcp__erp__create"), call("call_1", "outra")] },
			{ role: "tool", tool_call_id: "call_0", content: "Card de confirmação enviado." },
			{ role: "tool", tool_call_id: "call_1", content: UNEXECUTED_CALL_RESULT },
		];
		const byName = namespaceToolCallIds(attachPendingResult(asked, "mcp__erp__create", "criada")!, "run1");
		expect(byName.find((m) => m.content === "criada")!.tool_call_id).toBe(byName[1]!.tool_calls![0]!.id);
		const prefixedFirst = namespaceToolCallIds(asked, "run1");
		expect(attachPendingResult(prefixedFirst, "mcp__erp__create", "criada")!.find((m) => m.content === "criada")!.tool_call_id).toBe(prefixedFirst[1]!.tool_calls![0]!.id);
		const byTail = attachPendingResult(asked, undefined, "aprovado")!;
		expect(byTail.map((m) => m.content)).toEqual(["crie", null, "aprovado", UNEXECUTED_CALL_RESULT]);
	});

	it("sem nome, só vale se a conversa termina nos resultados da rodada", () => {
		expect(attachPendingResult([{ role: "user", content: "x" }, { role: "assistant", content: "texto" }], undefined, "r")).toBeNull();
	});
});

describe("notas de turno que seguem a tarefa", () => {
	it("renova com a mesma nota, expira depois de N turnos sem uso e respeita os limites", () => {
		let state = mergeCarriedNotes(undefined, ["Procedimento da skill X: passo 1, passo 2"]);
		expect(state.carried).toHaveLength(1);
		expect(state.reinject).toHaveLength(0);
		for (let turn = 1; turn <= CARRIED_NOTE_MAX_IDLE_TURNS; turn += 1) {
			state = mergeCarriedNotes(state.carried, []);
			expect(state.reinject).toHaveLength(1);
		}
		expect(mergeCarriedNotes(state.carried, []).carried).toHaveLength(0);
		const renewed = mergeCarriedNotes(state.carried, ["Procedimento da skill X: passo 1, passo 2"]);
		expect(renewed.carried).toEqual([expect.objectContaining({ idleTurns: 0 })]);
		expect(renewed.reinject).toHaveLength(0);
	});

	it("poucas e curtas: as mais antigas saem primeiro", () => {
		const many = mergeCarriedNotes(undefined, ["a".repeat(9_000), "b".repeat(9_000), "c", "d", "e"]);
		expect(many.carried.length).toBeLessThanOrEqual(4);
		expect(many.carried.every((note) => note.content.length <= 4_000)).toBe(true);
		expect(many.carried.reduce((sum, note) => sum + note.content.length, 0)).toBeLessThanOrEqual(10_000);
	});
});
