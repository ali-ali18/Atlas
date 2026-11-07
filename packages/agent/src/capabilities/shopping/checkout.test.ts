import type { Mandate } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { grantApproval, type ApprovalRequest } from "../../contract/index.js";
import { chatPolicy, setup } from "../../testing/contract-helpers.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import { TEST_CARD_NUMBER, TEST_CVV, TEST_HOLDER, paymentRig } from "../../testing/payment-fakes.js";
import { createCheckoutTool } from "./checkout.js";

const ARGS = {
	store: "Loja Teste",
	items: [{ name: "Camiseta azul", quantity: 2, price: 49.9 }],
	total: 109.8,
	shipping: 10,
	currency: "BRL",
	checkoutUrl: "https://www.loja.test/checkout/abc",
	cardId: "card-1",
};
const scopeOf = (request: ApprovalRequest, runId = "run-1", userId = "owner-1") => ({ userId, runId, requestId: request.id });

function rig() {
	const r = paymentRig();
	const tool = createCheckoutTool({ cards: [r.info], fill: r.fill });
	return { ...r, tool };
}

/** Tudo que poderia vazar: eventos, pedidos ao modelo, journal, recibos, checkpoint. */
function everything(h: ReturnType<typeof kernelHarness>): string {
	return JSON.stringify({ events: h.log.events, requests: h.llm.requests, journal: h.journal, receipts: h.receipts, checkpoints: [...h.runs.checkpoints.values()] });
}
const expectNoSecrets = (blob: string) => {
	for (const secret of [TEST_CARD_NUMBER, "4111 1111 1111 1111", "4111-1111-1111-1111", TEST_CVV, TEST_HOLDER]) expect(blob).not.toContain(secret);
};

describe("checkout: cartão de aprovação", () => {
	it("mostra loja, itens, total, frete e só o final do cartão; é money e sempre pede aprovação", async () => {
		const { tool } = rig();
		const { executor } = setup();
		const out = await executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS });
		if (out.status !== "pending_approval") throw new Error(out.status);
		expect(out.request.effect).toBe("money");
		expect(out.request.ownerInput).toBe("card_cvv");
		expect(out.request.inputOnly).toBeUndefined();
		expect(out.request.riskFacts).toMatchObject({ amount: 109.8, currency: "BRL", merchant: "loja.test", shipping: 10, card: "Visa final 1111", irreversible: true });
		expect(out.request.riskFacts.items).toEqual(["2× Camiseta azul · 49.90 BRL"]);
		expect(JSON.stringify(out.request)).not.toContain(TEST_CARD_NUMBER);
	});

	it("autonomia total não dispensa o cartão", async () => {
		const { tool } = rig();
		const { executor } = setup({ ...chatPolicy, autonomy: "autonomous" });
		expect((await executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS })).status).toBe("pending_approval");
	});

	it("a loja é o domínio da URL (não o nome dado pelo modelo) e só https vale", () => {
		const { tool } = rig();
		expect(tool.riskFactsFor({ ...ARGS, store: "mercado" })?.merchant).toBe("loja.test");
		expect(tool.riskFactsFor({ ...ARGS, checkoutUrl: "http://loja.test/x" })?.merchant).toBeUndefined();
	});
});

describe("checkout: caminho do CVV (executor)", () => {
	async function approved() {
		const r = rig();
		const s = setup();
		const pending = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		return { ...r, ...s, request: pending.request, grant: grantApproval(pending.request, s.clock.now()) };
	}

	it("aprovado COM CVV: a VM recebe cartão e CVV, a tool só recebe o resultado; o CVV morre no primeiro uso", async () => {
		const t = await approved();
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out).toMatchObject({ status: "ok" });
		expect(t.sandbox.actions).toHaveLength(1);
		const params = (t.sandbox.actions[0]!.action.params as { card: { number: string }; cvv: string });
		expect(params.card.number).toBe(TEST_CARD_NUMBER);
		expect(params.cvv).toBe(TEST_CVV);
		expect(t.backend.entries.size).toBe(0);
		if (out.status === "ok") {
			expect(out.summary).toContain("Visa final 1111");
			expect(out.receipt?.externalId).toBe("PED-1001");
			expectNoSecrets(JSON.stringify(out));
		}
		expectNoSecrets(JSON.stringify([t.journal, t.receipts]));
	});

	it("aprovação SEM CVV não executa: nada vai à VM e o erro é honesto", async () => {
		const t = await approved();
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.error).toContain("security code did not arrive");
		expect(t.sandbox.actions).toHaveLength(0);
	});

	it("CVV expirado (TTL) equivale a sem CVV", async () => {
		const t = await approved();
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 1_000);
		t.backend.now += 2_000;
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out.status).toBe("error");
		expect(t.sandbox.actions).toHaveLength(0);
	});

	it("o CVV só vale para aquele pedido: outro pedido, outro run ou outro dono não o consomem", async () => {
		const t = await approved();
		const other = [scopeOf(t.request, "run-2"), scopeOf(t.request, "run-1", "owner-2"), { ...scopeOf(t.request), requestId: "outro-pedido" }];
		for (const scope of other) await t.escrow.deposit(scope, TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out.status).toBe("error");
		expect(t.sandbox.actions).toHaveLength(0);
		// o do pedido certo continua intacto no canal dele? não foi depositado: nada a consumir
		for (const scope of other) expect(await t.escrow.take(scope)).not.toBeNull();
	});

	it("CVV copiado para a chave de outro pedido não abre (o selo leva a chave dentro)", async () => {
		const t = await approved();
		await t.escrow.deposit({ userId: "owner-1", runId: "run-1", requestId: "x" }, TEST_CVV, 60_000);
		const [[keyX, entry]] = [...t.backend.entries.entries()];
		t.backend.entries.clear();
		await t.backend.set(keyX!.replace(/[0-9a-f]{64}$/, "") + "0".repeat(64), entry!.value, 60_000);
		expect(await t.escrow.take(scopeOf(t.request))).toBeNull();
		expect(t.sandbox.actions).toHaveLength(0);
	});

	it("segunda aprovação com o mesmo CVV não executa de novo (journal e grant de uso único)", async () => {
		const t = await approved();
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		expect((await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant })).status).toBe("ok");
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const again = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(again.status).toBe("already_done");
		expect(t.sandbox.actions).toHaveLength(1);
	});

	it("argumentos mudados depois da aprovação invalidam o grant e o CVV fica sem uso", async () => {
		const t = await approved();
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: { ...ARGS, total: 999 }, grant: t.grant });
		expect(out.status).toBe("approval_invalid");
		expect(t.sandbox.actions).toHaveLength(0);
	});

	it("usuário B não usa cartão do A (cofre escopado por dono)", async () => {
		const r = paymentRig("owner-1");
		const tool = createCheckoutTool({ cards: [r.info], fill: r.fill });
		const s = setup(chatPolicy, { ownerId: "owner-2" });
		const pending = await s.executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		await r.escrow.deposit({ userId: "owner-2", runId: "run-1", requestId: pending.request.id }, TEST_CVV, 60_000);
		const out = await s.executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS, grant: grantApproval(pending.request, s.clock.now()) });
		expect(out.status).toBe("error");
		if (out.status === "error") expect(out.error).toContain("not found");
		expect(r.sandbox.actions).toHaveLength(0);
		// o CVV de B não fica esperando: o cartão não era dele
		expect(r.backend.entries.size).toBe(0);
	});

	it("o modelo de B nem vê o cartão de A: id desconhecido é recusado antes da aprovação poder gastar algo", async () => {
		const r = paymentRig("owner-1");
		const tool = createCheckoutTool({ cards: [], fill: r.fill });
		const s = setup(chatPolicy, { ownerId: "owner-2" });
		const pending = await s.executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		expect(pending.request.riskFacts.card).toBeUndefined();
		const out = await s.executor.executeCall({ callId: "c1", step: 1, tool, args: ARGS, grant: grantApproval(pending.request, s.clock.now()) });
		expect(out.status).toBe("error");
		expect(r.sandbox.actions).toHaveLength(0);
	});

	it("erro da VM com número e CVV no texto sai redigido", async () => {
		const t = await approved();
		t.sandbox.respond = () => ({ ok: false, error: `timeout no campo ${TEST_CARD_NUMBER} cvv ${TEST_CVV} de ${TEST_HOLDER}` });
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out.status).toBe("error");
		expectNoSecrets(JSON.stringify(out));
		expectNoSecrets(JSON.stringify(t.journal));
	});

	it("recusa do banco: erro honesto sem segredo", async () => {
		const t = await approved();
		t.sandbox.respond = () => ({ ok: true, data: { state: "declined", reason: `cartão ${TEST_CARD_NUMBER} recusado` } });
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out.status).toBe("error");
		expectNoSecrets(JSON.stringify(out));
	});

	it("sem navegador (VM indisponível): nada é pago e a dica manda oferecer o link", async () => {
		const t = await approved();
		t.sandbox.respond = () => ({ ok: false, error: "The computer is not available" });
		await t.escrow.deposit(scopeOf(t.request), TEST_CVV, 60_000);
		const out = await t.executor.executeCall({ callId: "c1", step: 1, tool: t.tool, args: ARGS, grant: t.grant });
		expect(out).toMatchObject({ status: "error", hint: expect.stringContaining("Nothing was paid") });
	});
});

describe("checkout: mandato (F6.4)", () => {
	const mandate = (over: Partial<Mandate> = {}): Mandate => ({ maxAmount: 200, currency: "BRL", merchants: ["loja.test"], until: "2027-01-01T00:00:00Z", usesLeft: 1, ...over });

	it("com mandato válido não há 'confirmar': o cartão vira só o campo do CVV (inputOnly) e ainda não executa", async () => {
		const r = rig();
		const s = setup({ ...chatPolicy, mandate: mandate() });
		const out = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS });
		if (out.status !== "pending_approval") throw new Error(out.status);
		expect(out.request.inputOnly).toBe(true);
		expect(out.request.ownerInput).toBe("card_cvv");
		expect(r.sandbox.actions).toHaveLength(0);
		expect(s.executor.mandateUsesLeft()).toBe(1);
	});

	it("com CVV digitado executa e gasta o uso; a compra seguinte volta ao cartão com 'confirmar'", async () => {
		const r = rig();
		const s = setup({ ...chatPolicy, mandate: mandate() });
		const pending = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		await r.escrow.deposit(scopeOf(pending.request), TEST_CVV, 60_000);
		expect((await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS, grant: grantApproval(pending.request, s.clock.now()) })).status).toBe("ok");
		expect(s.executor.mandateUsesLeft()).toBe(0);
		const next = await s.executor.executeCall({ callId: "c2", step: 2, tool: r.tool, args: ARGS });
		if (next.status !== "pending_approval") throw new Error(next.status);
		expect(next.request.inputOnly).toBeUndefined();
	});

	it("sem CVV o mandato também não executa nem gasta uso", async () => {
		const r = rig();
		const s = setup({ ...chatPolicy, mandate: mandate() });
		const pending = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS });
		if (pending.status !== "pending_approval") throw new Error(pending.status);
		const out = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS, grant: grantApproval(pending.request, s.clock.now()) });
		expect(out.status).toBe("error");
		expect(r.sandbox.actions).toHaveLength(0);
	});

	it("mandato não cobre: acima do valor, outra loja, vencido ou moeda diferente voltam ao cartão completo", async () => {
		const r = rig();
		for (const m of [mandate({ maxAmount: 50 }), mandate({ merchants: ["outra.test"] }), mandate({ until: "2026-01-01T00:00:00Z" }), mandate({ currency: "USD" })]) {
			const s = setup({ ...chatPolicy, mandate: m });
			const out = await s.executor.executeCall({ callId: "c1", step: 1, tool: r.tool, args: ARGS });
			if (out.status !== "pending_approval") throw new Error(out.status);
			expect(out.request.inputOnly).toBeUndefined();
		}
	});
});

describe("checkout: kernel de ponta a ponta (vazamento e handoff)", () => {
	function harness(turns: Parameters<typeof kernelHarness>[0]) {
		const r = paymentRig();
		const tool = createCheckoutTool({ cards: [r.info], fill: r.fill });
		return { r, h: kernelHarness(turns, { tools: [tool] }) };
	}

	it("compra completa: estaciona no cartão, retoma com grant + CVV e NADA vaza em evento, pedido ao modelo, journal, recibo ou checkpoint", async () => {
		const { r, h } = harness([reply({ calls: [call("p1", "checkout", ARGS)] }), reply({ text: "Comprei, pedido PED-1001." })]);
		expect((await h.run()).status).toBe("parked");
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		expect(card.request.toolName).toBe("checkout");
		await r.escrow.deposit(scopeOf(card.request), TEST_CVV, 60_000);
		const done = await h.run({ input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(done).toMatchObject({ status: "done", text: "Comprei, pedido PED-1001." });
		expect(r.sandbox.actions).toHaveLength(1);
		expectNoSecrets(everything(h));
		expect(h.receipts.items.map((x: { summary: string }) => x.summary).join(" ")).toContain("Visa final 1111");
	});

	it("aprovar sem CVV no kernel: o modelo recebe erro honesto e nada é pago", async () => {
		const { r, h } = harness([reply({ calls: [call("p1", "checkout", ARGS)] }), reply({ text: "Preciso que confirme de novo." })]);
		await h.run();
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		const done = await h.run({ input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(done.status).toBe("not_done");
		expect(r.sandbox.actions).toHaveLength(0);
		expect(JSON.stringify(h.log.of("tool_result"))).toContain("security code did not arrive");
	});

	it("3DS/app do banco: o run estaciona com handoff, o recibo mostra 'aguardando verificação' e a retomada NÃO repete o pagamento", async () => {
		const { r, h } = harness([reply({ calls: [call("p1", "checkout", ARGS)] }), reply({ text: "Conferi o pedido." })]);
		r.sandbox.respond = () => ({ ok: true, data: { state: "challenge", kind: "3ds" } });
		await h.run();
		const card = h.log.of("card")[0] as { request: ApprovalRequest };
		await r.escrow.deposit(scopeOf(card.request), TEST_CVV, 60_000);
		const parked = await h.run({ input: { ...h.input, resume: { grants: [grantApproval(card.request, h.ports.clock.now())] } } });
		expect(parked.status).toBe("parked");
		const handoffs = h.log.of("card").filter((c) => c.kind === "handoff");
		expect(handoffs).toHaveLength(1);
		expect(handoffs[0]!.userMessage).toContain("verificação");
		expect(h.log.of("receipt").some((x) => String(x.what).includes("waiting for the owner's verification"))).toBe(true);
		const done = await h.run({ input: { ...h.input, resume: { handoffDone: ["p1"] } } });
		expect(done).toMatchObject({ status: "done", text: "Conferi o pedido." });
		expect(r.sandbox.actions).toHaveLength(1);
		expectNoSecrets(everything(h));
	});
});
