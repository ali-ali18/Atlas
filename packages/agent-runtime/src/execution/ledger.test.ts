import { describe, expect, it } from "vitest";
import { buildRuntimeCheckpoint, parseRuntimeCheckpoint } from "../checkpoint.js";
import { executionDisciplineEnabled } from "./flag.js";
import { contentHash, extractItemIds } from "./item-ids.js";
import {
	LEDGER_MAX_CALLS_PER_DECISION,
	LEDGER_MAX_DECISIONS,
	LEDGER_MAX_SEEN_IDS,
	createExecutionLedger,
	identicalResultNotice,
	parseLedgerState,
} from "./ledger.js";
import { advanceStagnation } from "./stagnation.js";

const list = (ids: number[]) => JSON.stringify({ data: ids.map((id) => ({ id, name: `n${id}` })) });

describe("flag", () => {
	it("liga por padrão; off/0/false desligam", () => {
		expect(executionDisciplineEnabled({})).toBe(true);
		expect(executionDisciplineEnabled({ ATLAS_EXECUTION_DISCIPLINE: "on" })).toBe(true);
		for (const value of ["off", "OFF", "0", "false"]) {
			expect(executionDisciplineEnabled({ ATLAS_EXECUTION_DISCIPLINE: value })).toBe(false);
		}
	});
});

describe("extractItemIds", () => {
	it("extrai id/codigo/code/uuid/url e campos *_id, sem texto livre", () => {
		const ids = extractItemIds(
			JSON.stringify({ data: [{ id: 1, nested: { code: "A-1" } }, { uuid: "u-2", url: "https://x/y", owner_id: 9, title: "t" }] }),
		);
		expect(ids).toEqual(expect.arrayContaining(["id:1", "code:A-1", "uuid:u-2", "url:https://x/y", "owner_id:9"]));
		expect(ids).toHaveLength(5);
	});
	it("não-JSON, JSON inválido e vazio não têm ids", () => {
		expect(extractItemIds("texto livre id: 5")).toEqual([]);
		expect(extractItemIds("{not json at all")).toEqual([]);
		expect(extractItemIds("[]")).toEqual([]);
	});
	it("resultado cortado (JSON inválido) ainda rende os ids do prefixo", () => {
		const cut = '{"data":[{"id":1,"name":"a"},{"id":"x-2","name":"b"},{"id":3,"na' + "\n[Result truncated: showing ~60 of 900 characters]";
		expect(extractItemIds(cut)).toEqual(["id:1", "id:x-2", "id:3"]);
	});
	it("respeita o teto", () => {
		expect(extractItemIds(list(Array.from({ length: 50 }, (_, i) => i)), 10)).toHaveLength(10);
	});
	it("hash ignora espaços", () => {
		expect(contentHash("a  b\n c")).toBe(contentHash("a b c"));
		expect(contentHash("a")).not.toBe(contentHash("b"));
	});
});

describe("ExecutionLedger", () => {
	const base = { tool: "list_items", argKey: "k", ok: true };

	it("itens novos contam como novidade; a mesma lista reprojetada não", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: list([1, 2, 3]) });
		expect(ledger.endDecision(0).novelty).toBe(3);
		ledger.observe({ ...base, step: 1, resultText: JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }) });
		expect(ledger.endDecision(1).novelty).toBe(0);
		ledger.observe({ ...base, step: 2, resultText: list([3, 4]) });
		expect(ledger.endDecision(2).novelty).toBe(1);
	});

	it("sem ids, conteúdo novo (hash) conta; repetido não", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: "página A" });
		expect(ledger.endDecision(0).novelty).toBe(1);
		ledger.observe({ ...base, step: 1, resultText: "página A" });
		expect(ledger.endDecision(1).novelty).toBe(0);
	});

	it("escrita concluída é novidade; falha e tools de meio não", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, tool: "update_item", resultText: "ok", wrote: true });
		expect(ledger.endDecision(0).novelty).toBeGreaterThan(0);
		ledger.observe({ ...base, step: 1, ok: false, resultText: "erro novo" });
		ledger.observe({ ...base, step: 1, tool: "mcp_tool_search", resultText: "Already loaded: x" });
		expect(ledger.endDecision(1).novelty).toBe(0);
	});

	it("conteúdo idêntico com args diferentes aponta para a primeira chamada", () => {
		const ledger = createExecutionLedger();
		const first = ledger.observe({ ...base, step: 2, argKey: "a", resultText: list([1, 2]), ref: "run:2:a" });
		expect(first.identicalTo).toBeUndefined();
		const again = ledger.observe({ ...base, step: 5, argKey: "b", resultText: list([1, 2]), ref: "run:5:b" });
		expect(again.identicalTo).toEqual({ tool: "list_items", step: 2, ref: "run:2:a" });
		expect(identicalResultNotice(again.identicalTo!)).toBe(
			"Identical to the result of list_items at step 3 (result_ref: run:2:a); reuse it. Call read_cached_result with that result_ref only if you need the details again.",
		);
	});

	it("resposta do cache reaproveita o hash do original e não é novidade", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: list([1]), ref: "r:0" });
		ledger.endDecision(0);
		const hit = ledger.observe({ ...base, step: 1, resultText: "Already read this result.", reuseOfRef: "r:0" });
		expect(hit.newIds).toBe(0);
		expect(ledger.endDecision(1).novelty).toBe(0);
	});

	it("sobrevive a JSON (checkpoint) e não conta a mesma decisão duas vezes", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: list([1]) });
		ledger.endDecision(0);
		const restored = createExecutionLedger(JSON.parse(JSON.stringify(ledger.snapshot())));
		expect(restored.snapshot()).toEqual(ledger.snapshot());
		expect(restored.endDecision(0)).toEqual({ novelty: 1, nudge: null });
		expect(restored.snapshot().streak).toBe(0);
		const again = restored.observe({ ...base, step: 1, resultText: list([1]) });
		expect(again.newIds).toBe(0);
	});

	it("mantém tamanho limitado", () => {
		const ledger = createExecutionLedger();
		for (let step = 0; step < LEDGER_MAX_DECISIONS + 20; step += 1) {
			for (let call = 0; call < LEDGER_MAX_CALLS_PER_DECISION + 3; call += 1) {
				ledger.observe({ ...base, step, resultText: list([step * 100 + call, step * 1000 + call]) });
			}
			ledger.endDecision(step);
		}
		const state = ledger.snapshot();
		expect(state.decisions).toHaveLength(LEDGER_MAX_DECISIONS);
		expect(state.decisions.every((d) => d.calls.length <= LEDGER_MAX_CALLS_PER_DECISION)).toBe(true);
		expect(state.seenIds.length).toBeLessThanOrEqual(LEDGER_MAX_SEEN_IDS);
		expect(JSON.stringify(state).length).toBeLessThan(30_000);
	});

	it("noveltySince soma desde o passo", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: list([1, 2]) });
		ledger.observe({ ...base, step: 3, resultText: list([9]) });
		expect(ledger.noveltySince(0)).toBe(3);
		expect(ledger.noveltySince(1)).toBe(1);
		expect(ledger.noveltySince(4)).toBe(0);
	});

	it("estado inválido do checkpoint vira ledger vazio", () => {
		for (const raw of [null, "x", { v: 2 }, { v: 1, decisions: "no" }]) {
			expect(parseLedgerState(raw).decisions).toEqual([]);
		}
	});

	it("vai e volta pelo checkpoint do runtime", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ ...base, step: 0, resultText: list([1]) });
		const checkpoint = buildRuntimeCheckpoint({
			messages: [],
			conversation: [],
			nextStepIndex: 1,
			model: "m",
			executionLedger: ledger.snapshot(),
		});
		const parsed = parseRuntimeCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
		expect(parsed?.executionLedger).toEqual(ledger.snapshot());
		expect(parseRuntimeCheckpoint({ messages: [] })?.executionLedger).toBeUndefined();
	});
});

describe("estagnação (L6)", () => {
	it("avisa na 3a e na 5a decisão sem novidade, uma vez por sequência", () => {
		let state = { streak: 0, nudged: 0 as 0 | 1 | 2 };
		const messages: Array<string | null> = [];
		for (let i = 0; i < 8; i += 1) {
			const next = advanceStagnation(state, 0);
			state = next.state;
			messages.push(next.message);
		}
		expect(messages.map((m) => m?.includes("Change your approach") ? "change" : m?.includes("Stop calling tools") ? "stop" : null)).toEqual([
			null, null, "change", null, "stop", null, null, null,
		]);
	});
	it("novidade zera a sequência e libera novos avisos", () => {
		let state = { streak: 2, nudged: 0 as 0 | 1 | 2 };
		state = advanceStagnation(state, 2).state;
		expect(state).toEqual({ streak: 0, nudged: 0 });
		for (let i = 0; i < 2; i += 1) state = advanceStagnation(state, 0).state;
		expect(advanceStagnation(state, 0).message).toContain("Change your approach");
	});
	it("o ledger dispara os avisos nas decisões 3 e 5 e persiste a sequência no resume", () => {
		let current = createExecutionLedger();
		const nudges: Array<string | null> = [];
		for (let step = 0; step < 6; step += 1) {
			if (step === 4) current = createExecutionLedger(JSON.parse(JSON.stringify(current.snapshot())));
			current.observe({ tool: "list_items", argKey: "k", ok: true, step, resultText: "same content" });
			nudges.push(current.endDecision(step).nudge);
		}
		// step 0 traz conteúdo novo; 3a decisão sem novidade = step 3, 5a = step 5.
		expect(nudges.findIndex((n) => n?.includes("Change your approach"))).toBe(3);
		expect(nudges.findIndex((n) => n?.includes("Stop calling tools"))).toBe(5);
		expect(nudges.filter(Boolean)).toHaveLength(2);
	});
});

describe("V3: track_items e a chave da ação", () => {
	it("track_items não é evidência: declarar a lista não conta como novidade", () => {
		const ledger = createExecutionLedger();
		ledger.observe({ step: 0, tool: "track_items", argKey: "k", resultText: "Saved 9 items.", ok: true });
		expect(ledger.endDecision(0).novelty).toBe(0);
		ledger.observe({ step: 1, tool: "web_extract", argKey: "k2", resultText: "página nova", ok: true });
		expect(ledger.endDecision(1).novelty).toBe(1);
	});

	it("actionKey junta tool e alvo da decisão, e é vazia sem chamadas", () => {
		const ledger = createExecutionLedger();
		expect(ledger.actionKey(0)).toBe("");
		ledger.observe({ step: 0, tool: "computer", argKey: "click:e5", resultText: "x", ok: true });
		ledger.observe({ step: 0, tool: "web_search", argKey: "q", resultText: "y", ok: true });
		const key = ledger.actionKey(0);
		expect(key).toContain("computer:");
		expect(key).toContain("web_search:");
		ledger.observe({ step: 1, tool: "computer", argKey: "click:e5", resultText: "z", ok: true });
		expect(ledger.actionKey(1)).toContain("computer:");
	});
});
