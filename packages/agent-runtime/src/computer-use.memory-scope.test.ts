import { describe, expect, it, vi } from "vitest";
import { executeAgentMemoryTool, type AgentMemoryDeps } from "./computer-use.js";

function harness() {
	const calls: { fn: string; target: string }[] = [];
	const rec = (fn: string) => async (input: { target: string }) => (calls.push({ fn, target: input.target }), { ok: true });
	const ops = { addMemoryEntry: rec("add"), replaceMemoryEntry: rec("replace"), removeMemoryEntry: rec("remove") } as unknown as NonNullable<AgentMemoryDeps["ops"]>;
	const loadScope = vi.fn(async () => ({
		botNames: ["Cookie"],
		botProfile: { name: "Cookie", snippet: "Assistente amigável", description: "Assistente amigável para tarefas do dia a dia, investimentos e organização financeira." },
		requireCategory: false,
	}));
	return { calls, deps: { ops, loadScope } satisfies AgentMemoryDeps, loadScope };
}

describe("tool memory do agente: trava de escopo do perfil compartilhado", () => {
	it("descrição do bot, tom e pedido ao bot vão para a memória do bot", async () => {
		for (const content of [
			"Bot Cookie: assistente amigável para tarefas do dia a dia, investimentos e organização financeira.",
			"Tom amigável; revisões: só corrigir, manter breve e introdutório.",
			"Ana (Ana Souza) quer ajuda principalmente com bugs e documentação no bot, por ser desenvolvedor.",
		]) {
			const h = harness();
			const out = await executeAgentMemoryTool({ action: "add", target: "user", content, category: "identidade" }, "u1", "bot1", h.deps);
			// A descrição do bot é pulada (já está no perfil); as demais vão para a memória do bot.
			if (content.startsWith("Bot Cookie")) {
				expect(out).toContain("Não salvo");
				expect(h.calls).toEqual([]);
			} else {
				expect(out, content).toContain("movido de user para memory");
				expect(h.calls).toEqual([{ fn: "add", target: "memory" }]);
			}
		}
	});

	it("pedido de rotina não é salvo e aponta para propose_routine", async () => {
		const h = harness();
		const out = await executeAgentMemoryTool({ action: "add", target: "memory", content: "Quer uma rotina diária para consultar agenda e e-mail às 7h e às 20h." }, "u1", "bot1", h.deps);
		expect(out).toMatch(/Não salvo.*propose_routine/);
		expect(h.calls).toEqual([]);
	});

	it("perfil pessoal real (com ou sem categoria) continua em user", async () => {
		const h = harness();
		await executeAgentMemoryTool({ action: "add", target: "user", content: 'Nome: Ana Souza, apelido "ana". Fala pt-BR e prefere respostas curtas.', category: "identidade" }, "u1", "bot1", h.deps);
		await executeAgentMemoryTool({ action: "add", target: "user", content: "É estudante da PUCPR; pode pedir ajuda para acessar o AVA." }, "u1", "bot1", h.deps);
		expect(h.calls).toEqual([{ fn: "add", target: "user" }, { fn: "add", target: "user" }]);
	});

	it("categoria fora do perfil pessoal é rebaixada; repetir o perfil do bot é pulado; remove passa direto", async () => {
		const h = harness();
		await executeAgentMemoryTool({ action: "add", target: "user", content: "Investe em renda fixa", category: "financas" }, "u1", "bot1", h.deps);
		const skipped = await executeAgentMemoryTool({ action: "add", target: "memory", content: "Assistente amigável para tarefas do dia a dia, investimentos e finanças" }, "u1", "bot1", h.deps);
		await executeAgentMemoryTool({ action: "remove", target: "user", old_text: "Bot Cookie" }, "u1", "bot1", h.deps);
		expect(skipped).toContain("Não salvo");
		expect(h.calls).toEqual([{ fn: "add", target: "memory" }, { fn: "remove", target: "user" }]);
		expect(h.loadScope).toHaveBeenCalledTimes(2);
	});

	it("sem bot (run sem botId) não rebaixa", async () => {
		const h = harness();
		await executeAgentMemoryTool({ action: "add", target: "user", content: "Tom amigável; só corrigir", category: "comunicacao" }, "u1", undefined, h.deps);
		expect(h.calls).toEqual([{ fn: "add", target: "user" }]);
	});
});

describe("tool memory do agente: refs, list e merge", () => {
	function refHarness() {
		const seen: { fn: string; input: Record<string, unknown> }[] = [];
		const rec = (fn: string, result: unknown = { ok: true }) => async (input: Record<string, unknown>) => (seen.push({ fn, input }), result);
		const ambiguous = { ok: false, error: "oldText ambíguo (mais de uma entrada): repita com a ref da entrada certa", usage: "1194/1375 chars", currentEntries: ["[a2dl] Nome: Ana Souza, apelido ana", "[vgfz] Nome: Ana"] };
		const ops = {
			addMemoryEntry: rec("add"),
			replaceMemoryEntry: rec("replace"),
			removeMemoryEntry: async (input: Record<string, unknown>) => (seen.push({ fn: "remove", input }), input.ref ? { ok: true } : ambiguous),
			mergeMemoryEntries: rec("merge"),
		} as unknown as NonNullable<AgentMemoryDeps["ops"]>;
		const loadScope = async () => ({ botNames: [], botProfile: null, requireCategory: false });
		const loadSnapshot = async () => ({
			user: { entries: [{ id: "cabc0a2dl", content: "Nome: Ana Souza" }, { id: "cabc0vgfz", content: "Nome: Ana" }], usage: { used: 34, limit: 1375 } },
			memory: { entries: [], usage: { used: 0, limit: 2200 } },
		}) as never;
		return { seen, deps: { ops, loadScope, loadSnapshot } satisfies AgentMemoryDeps };
	}

	it("captura: remove por old_text curto devolve as candidatas com ref e a nova tentativa por ref passa", async () => {
		const h = refHarness();
		const first = await executeAgentMemoryTool({ action: "remove", target: "user", old_text: "Ana" }, "u1", "bot1", h.deps);
		expect(first).toContain("[a2dl] Nome: Ana Souza");
		expect(first).toContain("[vgfz] Nome: Ana");
		expect(first).toContain("ref");
		const second = await executeAgentMemoryTool({ action: "remove", target: "user", ref: "[vgfz]" }, "u1", "bot1", h.deps);
		expect(second).toContain("Memória atualizada");
		expect(h.seen[1]?.input).toMatchObject({ ref: "[vgfz]", target: "user", botId: "bot1", userId: "u1" });
	});

	it("list mostra as camadas com ref e uso, ou só a pedida", async () => {
		const h = refHarness();
		const all = await executeAgentMemoryTool({ action: "list" }, "u1", "bot1", h.deps);
		expect(all).toContain("user (34/1375 chars)");
		expect(all).toContain("[a2dl] Nome: Ana Souza");
		expect(all).toContain("memory (0/2200 chars)\n(vazio)");
		const only = await executeAgentMemoryTool({ action: "list", target: "memory" }, "u1", "bot1", h.deps);
		expect(only).not.toContain("Ana");
	});

	it("replace por ref passa pela trava de escopo; conteúdo que não é perfil pessoal não migra de camada", async () => {
		const h = refHarness();
		const ok = await executeAgentMemoryTool({ action: "replace", target: "user", ref: "a2dl", content: "Nome: Ana Souza (Ana)", category: "identidade" }, "u1", "bot1", h.deps);
		expect(ok).toContain("Memória atualizada");
		const refused = await executeAgentMemoryTool({ action: "replace", target: "user", ref: "a2dl", content: "Tom amigável; só corrigir", category: "comunicacao" }, "u1", "bot1", h.deps);
		expect(refused).toContain("Não salvo");
		const rotina = await executeAgentMemoryTool({ action: "merge", target: "memory", refs: ["aaaa", "bbbb"], content: "Quer uma rotina diária para consultar agenda e e-mail às 7h e às 20h." }, "u1", "bot1", h.deps);
		expect(rotina).toMatch(/Não salvo.*propose_routine/);
		expect(h.seen.map((call) => call.fn)).toEqual(["replace"]);
	});

	it("merge exige 2+ refs e repassa dono/bot; não aceita ref no lugar de camada errada", async () => {
		const h = refHarness();
		await expect(executeAgentMemoryTool({ action: "merge", target: "user", refs: ["a2dl"], content: "x" }, "u1", "bot1", h.deps)).rejects.toThrow(/2 ou mais/);
		const out = await executeAgentMemoryTool({ action: "merge", target: "user", refs: ["a2dl", "vgfz"], content: "Nome: Ana Souza (Ana)", category: "identidade" }, "u1", "bot1", h.deps);
		expect(out).toContain("merge em user");
		expect(h.seen[0]).toMatchObject({ fn: "merge", input: { refs: ["a2dl", "vgfz"], userId: "u1", botId: "bot1", target: "user", source: "agent-tool" } });
	});

	it("ref colada no início do content é descartada antes do gate e de salvar", async () => {
		const seen: Record<string, unknown>[] = [];
		const ops = { addMemoryEntry: async (i: Record<string, unknown>) => (seen.push(i), { ok: true }), replaceMemoryEntry: async (i: Record<string, unknown>) => (seen.push(i), { ok: true }), removeMemoryEntry: async () => ({ ok: true }) } as unknown as NonNullable<AgentMemoryDeps["ops"]>;
		const loadScope = async () => ({ botNames: [], botProfile: null, requireCategory: false });
		await executeAgentMemoryTool({ action: "add", target: "user", content: "- [a2dl] Nome: Ana Souza", category: "identidade" }, "u1", "bot1", { ops, loadScope });
		await executeAgentMemoryTool({ action: "replace", target: "user", ref: "a2dl", content: "[a2dl]Fuso: America/Sao_Paulo", category: "identidade" }, "u1", "bot1", { ops, loadScope });
		expect(seen.map((i) => i.content)).toEqual(["Nome: Ana Souza", "Fuso: America/Sao_Paulo"]);
	});
});
