import { describe, expect, it } from "vitest";
import { z } from "zod";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { defineTool } from "../tools/define-tool.js";
import { SAFETY_MAX_STEPS, UNATTENDED_MAX_STEPS, reachedLimit, stepCap } from "./limits.js";
import { MAX_REPEAT_NOTES, REPEAT_LIMIT, freshGuard, observeCall } from "./loop-guard.js";

const ping = defineTool({ name: "ping", description: "Ping.", inputSchema: z.object({ n: z.number().optional() }), effect: "read", execute: ({ n }) => ({ ok: true, summary: `pong ${n ?? 0}` }) });
const pingTurn = (id: string, n?: number) => reply({ calls: [call(id, "ping", n === undefined ? {} : { n })] });
const lastRequest = (h: ReturnType<typeof kernelHarness>) => h.llm.requests.at(-1);

describe("limites (puro)", () => {
	it("só o que o dono configurou mais a rede de segurança", () => {
		expect(stepCap({})).toEqual({ max: SAFETY_MAX_STEPS, kind: "steps_safety" });
		expect(stepCap({ unattended: true })).toEqual({ max: UNATTENDED_MAX_STEPS, kind: "steps_unattended" });
		expect(stepCap({ ownerMaxSteps: 300 })).toEqual({ max: SAFETY_MAX_STEPS, kind: "steps_safety" });
		expect(stepCap({ ownerMaxSteps: 7, unattended: true })).toEqual({ max: 7, kind: "steps_owner" });
		expect(reachedLimit({ step: 5, spentUsd: 99, limits: {} })).toBeUndefined();
		expect(reachedLimit({ step: 0, spentUsd: 1.5, limits: { ownerMaxUsd: 1 } })?.kind).toBe("cost");
	});

	it("guarda de laço: nota no 5º, 2 notas, e no 3º ciclo vira passo final; resultado diferente zera", () => {
		let g = freshGuard();
		const actions: string[] = [];
		for (let i = 0; i < REPEAT_LIMIT * (MAX_REPEAT_NOTES + 1); i++) {
			const v = observeCall(g, "same");
			g = v.state;
			actions.push(v.action);
		}
		expect(actions.filter((a) => a === "note")).toHaveLength(MAX_REPEAT_NOTES);
		expect(actions.at(-1)).toBe("final");
		const v = observeCall(observeCall(freshGuard(), "a").state, "b");
		expect(v.state.count).toBe(1);
	});
});

describe("kernel: limites e passo final", () => {
	it("teto de passos do dono: passo final com toolChoice none, nota honesta e texto do modelo intacto", async () => {
		const h = kernelHarness([pingTurn("c1", 1), pingTurn("c2", 2), reply({ text: "Feito: 2 consultas. Falta: o resto. Não confirmei: nada." })], { tools: [ping] });
		const result = await h.run({ limits: { ownerMaxSteps: 2 } });
		const final = lastRequest(h);
		expect(final?.toolChoice).toBe("none");
		expect(final?.tools?.map((t) => t.name)).toContain("ping");
		const note = JSON.stringify(final?.messages.at(-1));
		expect(note).toContain("what is done");
		expect(note).toContain("the step limit the owner set");
		expect(note).toContain("Spent so far: US$ 0.02 in 2 step(s)");
		expect(h.llm.requests.slice(0, -1).every((r) => r.toolChoice === undefined)).toBe(true);
		expect(result).toMatchObject({ status: "not_done", text: "Feito: 2 consultas. Falta: o resto. Não confirmei: nada.", stop: { kind: "steps_owner" } });
		expect(h.log.of("step").at(-1)).toMatchObject({ final: true });
	});

	it("teto de gasto do dono vira passo final com o gasto; sem teto o gasto não corta nada", async () => {
		const h = kernelHarness([reply({ calls: [call("a", "ping", {})], usage: { costUsd: 0.6 } }), reply({ calls: [call("b", "ping", { n: 1 })], usage: { costUsd: 0.6 } }), reply({ text: "resumo" })], { tools: [ping] });
		const out = await h.run({ limits: { ownerMaxUsd: 1 } });
		expect(out.stop?.kind).toBe("cost");
		expect(JSON.stringify(lastRequest(h)?.messages.at(-1))).toContain("US$ 1.00");
		const free = kernelHarness([...Array.from({ length: 30 }, (_, i) => reply({ calls: [call(`c${i}`, "ping", { n: i })], usage: { costUsd: 5 } })), reply({ text: "fim" })], { tools: [ping] });
		expect((await free.run()).status).toBe("done");
	});

	it("preço desconhecido não vira zero escondido: a nota diz quantos passos ficaram sem preço", async () => {
		const noPrice = reply({ calls: [call("a", "ping", {})] }).map((e) => (e.type === "done" ? { ...e, usage: { inputTokens: 1, outputTokens: 1 } } : e));
		const h = kernelHarness([noPrice, reply({ text: "ok" })], { tools: [ping] });
		await h.run({ limits: { ownerMaxSteps: 1 } });
		expect(JSON.stringify(lastRequest(h)?.messages.at(-1))).toContain("1 step(s) had no price information");
	});

	it("laço de chamadas idênticas: 2 notas ao modelo e depois passo final", async () => {
		let seq = 0;
		const same = () => pingTurn(`x${seq++}`);
		const turns = [...Array.from({ length: REPEAT_LIMIT * (MAX_REPEAT_NOTES + 1) }, same), reply({ text: "estou travado" })];
		const h = kernelHarness(turns, { tools: [ping] });
		const out = await h.run();
		expect(out).toMatchObject({ status: "not_done", stop: { kind: "repeated" }, text: "estou travado" });
		const notes = h.llm.requests.filter((r) => JSON.stringify(r.messages.at(-1)).includes("repeated the same call"));
		expect(notes.length).toBeGreaterThan(0);
		expect(lastRequest(h)?.toolChoice).toBe("none");
		expect(JSON.stringify(lastRequest(h)?.messages.at(-1))).toContain("repeated identical calls");
	});
});

describe("kernel: só retries de transporte", () => {
	it("resposta cortada (length) tem UMA continuação e o texto sai junto, sem alterar", async () => {
		const h = kernelHarness([reply({ text: "Primeira parte, ", finish: "length" }), reply({ text: "segunda parte." })]);
		const out = await h.run();
		expect(out).toMatchObject({ status: "done", text: "Primeira parte, segunda parte." });
		const cont = h.llm.requests[1]?.messages.slice(-2);
		expect(cont?.[0]).toEqual({ role: "assistant", content: "Primeira parte, " });
		expect(JSON.stringify(cont?.[1])).toContain("cut off");
		// o histórico guardado tem uma mensagem só, sem a nota de continuação
		const stored = (h.runs.checkpoints.get("owner-1:run-1")?.payload as { messages: Array<{ role: string; content: string }> }).messages;
		expect(stored.filter((m) => m.role === "assistant")).toEqual([{ role: "assistant", content: "Primeira parte, segunda parte." }]);
	});

	it("cortada duas vezes: aceita o texto e avisa por status, sem inventar", async () => {
		const h = kernelHarness([reply({ text: "a", finish: "length" }), reply({ text: "b", finish: "length" })]);
		const out = await h.run();
		expect(out.text).toBe("ab");
		expect(h.log.of("status").map((s) => s.reason)).toContain("truncated");
	});

	it("erro do provedor: um retry igual; falhando de novo, status real e run failed", async () => {
		const ok = kernelHarness([reply({ finish: "error" }), reply({ text: "voltou" })]);
		expect((await ok.run()).text).toBe("voltou");
		const bad = kernelHarness([reply({ finish: "error" }), reply({ finish: "error" })]);
		const out = await bad.run();
		expect(out).toMatchObject({ status: "failed", reason: "model_error" });
		expect(bad.log.of("status")[0]).toMatchObject({ reason: "model_error" });
	});

	it("resposta vazia: um retry; vazia de novo vira status com o motivo e nenhum texto é inventado", async () => {
		const h = kernelHarness([reply({}), reply({})]);
		const out = await h.run();
		expect(out).toMatchObject({ status: "done", text: "", reason: "empty_reply" });
		expect(h.log.of("status")[0]).toMatchObject({ reason: "empty_reply" });
		expect(h.llm.requests).toHaveLength(2);
		expect(h.llm.requests[1]?.messages).toEqual(h.llm.requests[0]?.messages);
	});

	it("tool malformada: o erro volta como dado e o modelo tenta de novo; a segunda seguida para com status", async () => {
		const h = kernelHarness([reply({ calls: [call("m1", "nao_existe", {})] }), reply({ calls: [call("m2", "ping", "texto")] }), reply({ text: "nunca chega" })], { tools: [ping] });
		const out = await h.run();
		expect(out).toMatchObject({ status: "not_done", reason: "malformed_tool_call" });
		expect(JSON.stringify(h.llm.requests[1]?.messages.at(-1))).toContain('Unknown tool \\"nao_existe\\"');
		const retry = kernelHarness([reply({ calls: [call("m1", "nao_existe", {})] }), pingTurn("ok1"), reply({ text: "certo" })], { tools: [ping] });
		expect((await retry.run()).text).toBe("certo");
	});

	it("nenhum nudge: o modelo diz 'vou fazer' sem tool e o turno encerra do mesmo jeito", async () => {
		const h = kernelHarness([reply({ text: "Vou pesquisar isso agora." })], { tools: [ping] });
		const out = await h.run();
		expect(out).toMatchObject({ status: "done", text: "Vou pesquisar isso agora." });
		expect(h.llm.requests).toHaveLength(1);
	});

	it("tool que falhou e foi relatada termina como not_done, sem continuar sozinha", async () => {
		const broken = defineTool({ name: "fetch_video", description: "Fetch.", inputSchema: z.object({}), effect: "read", execute: () => ({ ok: false, error: "403 forbidden", hint: "ask the owner" }) });
		const h = kernelHarness([reply({ calls: [call("f1", "fetch_video", {})] }), reply({ text: "Não consegui abrir o vídeo (403)." })], { tools: [broken] });
		const out = await h.run();
		expect(out).toMatchObject({ status: "not_done", unresolved: { fetch_video: "403 forbidden" } });
		expect(h.llm.requests).toHaveLength(2);
	});
});
