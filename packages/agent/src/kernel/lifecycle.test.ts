import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRunMessages, createRunNonce } from "../channels/index.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { defineTool } from "../tools/define-tool.js";
import { declinedOffersNote, emptyConversation, openOffer, settleOffers } from "./offers.js";

const OFFER = "continuar o resumo do vídeo";
const ask = (id: string, offer?: string) => reply({ calls: [call(id, "ask_owner", { question: "Quer que eu continue o resumo?", ...(offer && { offer }) })], text: "Não consegui abrir o vídeo." });
const runtimeBlocks = (messages: unknown) => JSON.stringify(messages).match(/<atlas:runtime/g)?.length ?? 0;

describe("ofertas (puro)", () => {
	const open = openOffer(emptyConversation(), { cardId: "c1", label: OFFER });
	it("o dono respondeu: answered, nada declinado", () => {
		const s = settleOffers(open, { responses: [{ cardId: "c1", response: "answered" }], ownerSpoke: false });
		expect(s.offers[0]?.state).toBe("answered");
		expect(s.declinedOffers).toEqual([]);
	});
	it("o dono dispensou o cartão: dismissed e declinada", () => {
		const s = settleOffers(open, { responses: [{ cardId: "c1", response: "dismissed" }], ownerSpoke: true });
		expect(s).toMatchObject({ offers: [{ state: "dismissed" }], declinedOffers: [OFFER] });
	});
	it("o dono mandou outra mensagem sem tocar no cartão: ignored (estrutural) e declinada", () => {
		const s = settleOffers(open, { responses: [], ownerSpoke: true });
		expect(s).toMatchObject({ offers: [{ state: "ignored" }], declinedOffers: [OFFER] });
	});
	it("run que não veio do dono (rotina, evento) não fecha a oferta", () => {
		expect(settleOffers(open, { responses: [], ownerSpoke: false }).offers[0]?.state).toBe("open");
	});
	it("oferta já fechada não muda e o aviso sai uma linha por oferta, escapado", () => {
		const closed = settleOffers(open, { responses: [], ownerSpoke: true });
		expect(settleOffers(closed, { responses: [{ cardId: "c1", response: "answered" }], ownerSpoke: true })).toEqual(closed);
		expect(declinedOffersNote([])).toBeUndefined();
		expect(declinedOffersNote(["a", "b"])?.split("\n")).toHaveLength(2);
	});
});

describe("kernel: oferta é um cartão com estado", () => {
	it("ask_owner mostra o cartão, registra a oferta aberta e encerra o turno sem nova chamada ao modelo", async () => {
		const h = kernelHarness([ask("q1", OFFER)]);
		const out = await h.run({ input: { ...h.input, conversationId: "conv-1" } });
		expect(out).toMatchObject({ status: "done", text: "Não consegui abrir o vídeo.\n\nQuer que eu continue o resumo?", awaiting: "run-1:q1" });
		expect(h.llm.requests).toHaveLength(1);
		expect(h.log.of("card")[0]).toMatchObject({ kind: "ask_owner", cardId: "run-1:q1", offer: OFFER });
		expect((await h.conversations.get("owner-1", "conv-1")).offers).toEqual([{ cardId: "run-1:q1", label: OFFER, state: "open" }]);
	});

	it("a pergunta vira o texto final persistido, sem duplicar quando o modelo já a trouxe (B15)", async () => {
		const bare = kernelHarness([reply({ calls: [call("q1", "ask_owner", { question: "Qual conta?" })] })]);
		expect((await bare.run()).text).toBe("Qual conta?");
		expect(bare.log.of("final")[0]?.text).toBe("Qual conta?");
		const said = kernelHarness([reply({ text: "Qual conta?", calls: [call("q1", "ask_owner", { question: "Qual conta?" })] })]);
		expect((await said.run()).text).toBe("Qual conta?");
	});

	it("duas perguntas no mesmo passo: só a primeira vira cartão; a segunda volta ao modelo com erro honesto (B15)", async () => {
		const h = kernelHarness([reply({ calls: [call("q1", "ask_owner", { question: "Primeira?" }), call("q2", "ask_owner", { question: "Segunda?" })] })]);
		const out = await h.run();
		expect(out.awaiting).toBe("run-1:q1");
		expect(h.log.of("card")).toHaveLength(1);
		const results = Object.fromEntries(h.log.of("tool_result").map((r) => [r.callId, r]));
		expect(results.q1?.status).toBe("ok");
		expect(results.q2?.status).toBe("error");
		expect(String(results.q2?.content)).toContain("only one such call");
	});

	it("ignorada: o dono manda outra mensagem sem tocar no cartão; o aviso aparece nos runs seguintes", async () => {
		const h = kernelHarness([ask("q1", OFFER), reply({ text: "ok, boa tarde" }), reply({ text: "de novo" })]);
		await h.run({ input: { ...h.input, conversationId: "conv-1" } });
		const history = [...h.input.history, { kind: "owner" as const, text: "que horas são?" }];
		await h.run({ runId: "run-2", input: { ...h.input, history, conversationId: "conv-1" } });
		const note = JSON.stringify(h.llm.requests[1]?.messages.at(-1));
		expect(note).toContain(`You already offered \\"${OFFER}\\" and the owner declined it. Do not offer it again.`);
		expect((await h.conversations.get("owner-1", "conv-1")).offers[0]?.state).toBe("ignored");
		await h.run({ runId: "run-3", input: { ...h.input, history, conversationId: "conv-1" } });
		expect(JSON.stringify(h.llm.requests[2]?.messages.at(-1))).toContain(OFFER);
	});

	it("dispensada pelo cartão: também vira declinada; respondida: não", async () => {
		const dismissed = kernelHarness([ask("q1", OFFER), reply({ text: "ok" })]);
		await dismissed.run({ input: { ...dismissed.input, conversationId: "c" } });
		await dismissed.run({ runId: "r2", input: { ...dismissed.input, conversationId: "c", cardResponses: [{ cardId: "run-1:q1", response: "dismissed" }] } });
		expect(JSON.stringify(dismissed.llm.requests[1]?.messages)).toContain("the owner declined it");
		const answered = kernelHarness([ask("q1", OFFER), reply({ text: "ok" })]);
		await answered.run({ input: { ...answered.input, conversationId: "c" } });
		await answered.run({ runId: "r2", input: { ...answered.input, conversationId: "c", cardResponses: [{ cardId: "run-1:q1", response: "answered" }] } });
		expect(runtimeBlocks(answered.llm.requests[1]?.messages)).toBe(0);
	});

	it("pergunta sem `offer` não vira oferta e nunca é declinada", async () => {
		const h = kernelHarness([ask("q1"), reply({ text: "ok" })]);
		await h.run({ input: { ...h.input, conversationId: "c" } });
		await h.run({ runId: "r2", input: { ...h.input, conversationId: "c" } });
		expect((await h.conversations.get("owner-1", "c")).declinedOffers).toEqual([]);
		expect(runtimeBlocks(h.llm.requests[1]?.messages)).toBe(0);
	});

	it("escopo: o aviso é por conversa e por dono (outro dono ou outra conversa não recebe)", async () => {
		const h = kernelHarness([ask("q1", OFFER), reply({ text: "a" }), reply({ text: "b" }), reply({ text: "c" })]);
		await h.run({ input: { ...h.input, conversationId: "conv-A" } });
		await h.run({ runId: "r2", input: { ...h.input, conversationId: "conv-A" } });
		await h.run({ runId: "r3", input: { ...h.input, conversationId: "conv-B" } });
		await h.run({ runId: "r4", ownerId: "owner-2", input: { ...h.input, conversationId: "conv-A" } });
		expect(JSON.stringify(h.llm.requests[1]?.messages)).toContain(OFFER);
		expect(runtimeBlocks(h.llm.requests[2]?.messages)).toBe(0);
		expect(runtimeBlocks(h.llm.requests[3]?.messages)).toBe(0);
	});
});

describe("kernel: tarefa não atravessa runs (caso real do dono)", () => {
	const fetchVideo = defineTool({ name: "fetch_video", description: "Fetch a video.", inputSchema: z.object({ url: z.string() }), effect: "read", execute: () => ({ ok: false, error: "403 forbidden" }) });

	it("resumo do vídeo falhou, o dono ficou em silêncio e mandou outra coisa: o contexto não carrega rastro da tarefa antiga", async () => {
		const h = kernelHarness([reply({ calls: [call("f1", "fetch_video", { url: "https://example.com/v" })] }), reply({ text: "Não consegui abrir o vídeo (403)." }), reply({ text: "Beba água." })], { tools: [fetchVideo] });
		const first = { ...h.input, history: [{ kind: "owner" as const, text: "resuma o vídeo https://example.com/v" }], conversationId: "conv" };
		const r1 = await h.run({ input: first });
		expect(r1).toMatchObject({ status: "not_done", unresolved: { fetch_video: "403 forbidden" } });
		expect(h.llm.requests).toHaveLength(2); // sem continuação automática

		const history = [...first.history, { kind: "owner" as const, text: "me lembra de beber água às 15h" }];
		const r2 = await h.run({ runId: "run-2", input: { ...first, history } });
		expect(r2).toMatchObject({ status: "done", text: "Beba água." });
		const ctx = h.llm.requests[2]?.messages;
		const nonce = createRunNonce(h.ports.random);
		// o contexto montado é exatamente o histórico normal: nenhuma nota de runtime, nenhum item aberto
		expect(ctx).toEqual(buildRunMessages({ nonce, stableSystem: "SYSTEM", contextSections: [], history }));
		expect(runtimeBlocks(ctx)).toBe(0);
		expect(JSON.stringify(ctx)).not.toMatch(/open items|previous task|unfinished|fetch_video|403/i);
		// o kernel não gravou nada sobre a tarefa antiga
		expect(await h.conversations.get("owner-1", "conv")).toEqual({ offers: [], declinedOffers: [] });
		expect(h.notes.items.size).toBe(0);
	});
});
