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
} from "./transcript.js";
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
	it("tira system das camadas, mantém notas de resumo e os resultados de ferramenta", () => {
		const cleaned = cleanTranscript([
			{ role: "system", content: "camada" },
			{ role: "system", content: `${SUMMARY_NOTE_PREFIX} resumo` },
			...run1.slice(1),
			{ role: "system", content: "nota transitória" },
		])!;
		expect(cleaned.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(cleaned[0]!.content).toContain(SUMMARY_NOTE_PREFIX);
		expect(cleaned[3]!.content).toContain("Alfa");
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
