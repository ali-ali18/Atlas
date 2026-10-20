import { describe, expect, it, vi } from "vitest";
import { executeAgentMemoryTool, type AgentMemoryDeps } from "./computer-use.js";
import type { MemoryGateVerdict, MemoryJudge } from "./memory-gate.js";

function harness(verdict: MemoryGateVerdict | Error = { action: "save" }) {
	const calls: { fn: string; ref?: string; content?: string }[] = [];
	const rec = (fn: string) => async (input: { ref?: string; content?: string }) => (calls.push({ fn, ref: input.ref, content: input.content }), { ok: true });
	const ops = { addMemoryEntry: rec("add"), replaceMemoryEntry: rec("replace"), removeMemoryEntry: rec("remove"), mergeMemoryEntries: rec("merge") } as unknown as NonNullable<AgentMemoryDeps["ops"]>;
	const judge = vi.fn<MemoryJudge>(async () => {
		if (verdict instanceof Error) throw verdict;
		return [verdict];
	});
	const loadSnapshot = vi.fn(async () => ({
		user: { entries: [], usage: { used: 0, limit: 1 } },
		memory: { entries: [{ id: "entry-1", content: "Cliente Silva paga dia 10" }], usage: { used: 0, limit: 1 } },
	})) as unknown as NonNullable<AgentMemoryDeps["loadSnapshot"]>;
	const loadScope = async () => ({ botNames: [], botProfile: null, requireCategory: false });
	return { calls, judge, deps: { ops, judge, loadSnapshot, loadScope } satisfies AgentMemoryDeps };
}

const fact = { action: "add", target: "memory", content: "Silva também aceita pix", category: "cliente" } as const;

describe("tool memory do agente: porteiro", () => {
	it("user_asked grava direto, sem chamar o porteiro", async () => {
		const h = harness({ action: "discard", reason: "trivial" });
		const out = await executeAgentMemoryTool({ ...fact, user_asked: true }, "u1", "bot1", h.deps);
		expect(out).toContain("Memória atualizada");
		expect(h.judge).not.toHaveBeenCalled();
		expect(h.calls).toEqual([{ fn: "add", ref: undefined, content: fact.content }]);
	});

	it("sem user_asked o porteiro roda (com as entradas atuais) e descartar não grava e explica", async () => {
		const h = harness({ action: "discard", reason: "tarefa já concluída" });
		const out = await executeAgentMemoryTool(fact, "u1", "bot1", h.deps);
		expect(out).toMatch(/Não salvo pelo porteiro da memória: tarefa já concluída/);
		expect(out).toContain("user_asked=true");
		expect(h.calls).toEqual([]);
		expect(h.judge.mock.calls[0]![0].existing.memory).toEqual([{ id: "entry-1", content: "Cliente Silva paga dia 10" }]);
		expect(h.judge.mock.calls[0]![0].candidates[0]).toMatchObject({ target: "memory", content: fact.content, replaces: false });
	});

	it("merge troca o add por um replace da entrada existente", async () => {
		const h = harness({ action: "merge", entryId: "entry-1", oldText: "Cliente Silva paga dia 10", content: "Cliente Silva paga dia 10, boleto ou pix" });
		const out = await executeAgentMemoryTool(fact, "u1", "bot1", h.deps);
		expect(out).toContain("fundida");
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toMatchObject({ fn: "replace", content: "Cliente Silva paga dia 10, boleto ou pix" });
		expect(h.calls[0]!.ref).toBeTruthy();
	});

	it("erro do porteiro ou do carregamento da camada grava (fail-open)", async () => {
		const h = harness(new Error("boom"));
		expect(await executeAgentMemoryTool(fact, "u1", "bot1", h.deps)).toContain("Memória atualizada");
		expect(h.calls.map((c) => c.fn)).toEqual(["add"]);
		const h2 = harness({ action: "discard", reason: "x" });
		h2.deps.loadSnapshot = async () => {
			throw new Error("db");
		};
		expect(await executeAgentMemoryTool(fact, "u1", "bot1", h2.deps)).toContain("Memória atualizada");
	});

	it("remove, list e merge não passam pelo porteiro; replace passa", async () => {
		const h = harness({ action: "discard", reason: "x" });
		await executeAgentMemoryTool({ action: "remove", target: "memory", ref: "aaaa" }, "u1", "bot1", h.deps);
		await executeAgentMemoryTool({ action: "list" }, "u1", "bot1", h.deps);
		await executeAgentMemoryTool({ action: "merge", target: "memory", refs: ["aaaa", "bbbb"], content: "junto" }, "u1", "bot1", h.deps);
		expect(h.judge).not.toHaveBeenCalled();
		const out = await executeAgentMemoryTool({ action: "replace", target: "memory", ref: "aaaa", content: "novo texto" }, "u1", "bot1", h.deps);
		expect(h.judge).toHaveBeenCalledTimes(1);
		expect(h.judge.mock.calls[0]![0].candidates[0]!.replaces).toBe(true);
		expect(out).toContain("Não salvo pelo porteiro");
	});

	it("sem porteiro nas dependências grava como antes", async () => {
		const h = harness();
		const { judge: _unused, ...rest } = h.deps;
		expect(await executeAgentMemoryTool(fact, "u1", "bot1", rest)).toContain("Memória atualizada");
	});
});
