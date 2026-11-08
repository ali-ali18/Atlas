import { describe, expect, it } from "vitest";
import { FakeAgenda, FakeSearch, FakeShopping, productPageHtml } from "../../presets/fakes.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { Ports } from "../../ports/index.js";
import type { ToolContext } from "../../tools/types.js";
import { DEFAULT_PROACTIVE_SETTINGS } from "@workspace/shared";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { createShoppingCapability } from "./index.js";

// Relógio dos testes: 2026-11-05 12:00Z.
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock() } as unknown as Ports, ...over });

function setup() {
	const shop = new FakeShopping();
	const agenda = new FakeAgenda();
	const urls = { a: "https://loja-a.test/p/fone", b: "https://loja-b.test/p/fone", c: "https://loja-c.test/p/fone", blog: "https://blog.test/review" };
	shop.html.set(urls.a, productPageHtml({ name: "Fone X", price: 100, shipping: 40, merchant: "Loja A", images: ["https://cdn.a.test/1.jpg", "https://cdn.a.test/2.jpg"], rating: { value: 4.5, count: 80 } }));
	shop.html.set(urls.b, productPageHtml({ name: "Fone X", price: 120, shipping: 0, merchant: "Loja B" }));
	shop.html.set(urls.c, productPageHtml({ name: "Fone X", price: 90, merchant: "Loja C" })); // frete não informado
	shop.html.set(urls.blog, "<html><head><title>Review</title></head><body>texto</body></html>");
	const search = new FakeSearch(Object.values(urls).map((url) => ({ title: url, url, snippet: "" })));
	const cap = createShoppingCapability({ ...shop.ports, search, agenda });
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	return { shop, agenda, search, cap, tool, urls };
}

describe("capacidade shopping: forma", () => {
	it("é lazy, declara os cards e os efeitos certos", () => {
		const { cap, tool } = setup();
		expect(cap.core).toBe(false);
		expect(cap.cards).toEqual(["product", "purchase"]);
		expect(cap.tools.map((t) => t.name)).toEqual(["product_search", "record_purchase", "purchase_list", "purchase_update", "purchase_delete"]);
		expect(tool("product_search")).toMatchObject({ effect: "read", trust: "untrusted", source: "web", egress: true });
		expect(tool("record_purchase")).toMatchObject({ effect: "write_internal", egress: false });
		for (const name of ["record_purchase", "purchase_update", "purchase_delete"]) expect(tool(name).confirm).toBe("when_untrusted");
		expect(tool("purchase_list")).toMatchObject({ effect: "read", privateData: true, ownerData: "purchase" });
	});
	it("a frente C anexa tools à mesma capacidade, sem mexer nas daqui", async () => {
		const { shop, search } = setup();
		const checkout = defineTool({ name: "checkout", description: "x", inputSchema: z.object({}), effect: "money", execute: () => ({ ok: true, summary: "ok" }) });
		const extended = createShoppingCapability({ ...shop.ports, search, extraTools: [checkout], extraInstructions: "Checkout rules." });
		expect(extended.tools.map((t) => t.name)).toEqual(["product_search", "record_purchase", "purchase_list", "purchase_update", "purchase_delete", "checkout"]);
		expect(extended.instructions).toContain("Checkout rules.");
		expect(extended.id).toBe("shopping");
	});
});

describe("run de agenda (wake): compras só leem", () => {
	it("readOnly deixa só product_search; as tools de escrita ficam fora e a instrução não as promete", () => {
		const { shop, search, agenda } = setup();
		const wake = createShoppingCapability({ ...shop.ports, search, agenda, readOnly: true });
		expect(wake.tools.map((t) => t.name)).toEqual(["product_search"]);
		expect(wake.instructions).not.toContain("record_purchase");
		expect(wake.instructions).toContain("only reads");
	});
	it("a instrução do chat manda registrar só compra que o dono fez ou confirmou", () => {
		expect(setup().cap.instructions).toContain("Record only a purchase the owner made or confirmed");
	});
});

describe("purchase_update e purchase_delete", () => {
	const buy = { merchant: "Loja B", items: [{ name: "Fone X", quantity: 1 }], total: 120, currency: "BRL", orderNumber: "B-77" };

	it("update mescla só o que veio, revalida e mostra o card", async () => {
		const { tool, shop } = setup();
		await tool("record_purchase").run(buy, ctx());
		const out = await tool("purchase_update").run({ purchaseId: "pur-1", trackingCode: "BR9", trackingUrl: "https://rastreio.test/BR9", total: 130 }, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { externalId: "pur-1" } });
		expect(shop.rows[0]).toMatchObject({ merchant: "Loja B", orderNumber: "B-77", trackingCode: "BR9", total: 130 });
		expect(shop.purchaseCards.length).toBeGreaterThan(1);
		expect(await tool("purchase_update").run({ purchaseId: "pur-1", trackingUrl: "javascript:alert(1)" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("trackingUrl") });
		expect(await tool("purchase_update").run({ purchaseId: "pur-1" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Nothing to change") });
		expect(shop.rows[0]!.trackingUrl).toBe("https://rastreio.test/BR9");
	});
	it("delete apaga a compra e encerra o vigia dela", async () => {
		const { tool, shop, agenda } = setup();
		await tool("record_purchase").run(buy, ctx());
		const out = await tool("purchase_delete").run({ purchaseId: "pur-1" }, ctx());
		expect(out.ok && out.summary).toContain("follow-up was stopped");
		expect(shop.rows).toHaveLength(0);
		expect([...agenda.items.values()][0]).toMatchObject({ status: "cancelled" });
	});
	it("IDOR: outro dono não corrige nem apaga (mesmo erro de inexistente) e nada muda", async () => {
		const { tool, shop, agenda } = setup();
		await tool("record_purchase").run(buy, ctx({ ownerId: "o1" }));
		const upd = await tool("purchase_update").run({ purchaseId: "pur-1", total: 1 }, ctx({ ownerId: "o2" }));
		const del = await tool("purchase_delete").run({ purchaseId: "pur-1" }, ctx({ ownerId: "o2" }));
		const missing = await tool("purchase_delete").run({ purchaseId: "nao-existe" }, ctx({ ownerId: "o1" }));
		for (const r of [upd, del, missing]) expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Purchase not found") });
		expect(shop.rows).toHaveLength(1);
		expect(shop.rows[0]!.total).toBe(120);
		expect([...agenda.items.values()][0]!.status).toBe("pending");
	});
	it("contrato: descrição diz quando usar e quando não usar; efeito write_internal", () => {
		const { tool } = setup();
		for (const name of ["purchase_update", "purchase_delete"]) {
			expect(tool(name).effect).toBe("write_internal");
			expect(tool(name).description).toMatch(/Use it/);
			expect(tool(name).description).toMatch(/Do not use/);
		}
	});
});

describe("product_search", () => {
	it("compara pelo TOTAL com frete, avisa o frete não informado e emite um card só", async () => {
		const { tool, shop, urls } = setup();
		const out = await tool("product_search").run({ query: "fone bluetooth X" }, ctx());
		expect(out.ok).toBe(true);
		const summary = out.ok ? out.summary : "";
		// A: 100 + 40 = 140; B: 120 + 0 = 120 (mais barato pelo total, embora A tenha preço menor que B); C: 90 sem frete = desconhecido.
		expect(summary).toContain("TOTAL 140.00 BRL");
		expect(summary).toContain("TOTAL 120.00 BRL");
		expect(summary).toContain("shipping not informed");
		expect(summary).toContain("total unknown (shipping not informed, do not assume zero)");
		expect(summary).toContain(`Lowest TOTAL among stores with a known total: ${urls.b}`);
		expect(summary).toContain("Some stores did not inform shipping");
		expect(summary).toContain(`${urls.blog} (no structured product data on the page)`);
		expect(shop.productCards).toHaveLength(1);
		const card = shop.productCards[0]!.card;
		expect(card.items.map((i) => i.total)).toEqual([140, 120, null]);
		expect(card).toMatchObject({ cheapestUrl: urls.b, incomplete: true });
		expect(card.items[0]).toMatchObject({ images: ["https://cdn.a.test/1.jpg", "https://cdn.a.test/2.jpg"], rating: { value: 4.5, count: 80 }, merchant: "Loja A" });
		expect(shop.fetched.every((f) => f.userId === "o1")).toBe(true);
	});
	it("pelas URLs, sem busca; a mesma busca repetida no run reaproveita o card", async () => {
		const { tool, shop, search, urls } = setup();
		const input = { urls: [urls.a, urls.b] };
		await tool("product_search").run(input, ctx());
		await tool("product_search").run(input, ctx());
		expect(search.queries).toHaveLength(0);
		expect(shop.productCards).toHaveLength(1);
	});
	it("um produto só: card sem comparação", async () => {
		const { tool, shop, urls } = setup();
		const out = await tool("product_search").run({ urls: [urls.a] }, ctx());
		expect(out.ok && out.summary).not.toContain("Lowest TOTAL");
		expect(shop.productCards[0]!.card.cheapestUrl).toBeUndefined();
	});
	it("falha de verdade (ok:false) quando nenhuma página tem dado de produto; página fora do ar não derruba as outras", async () => {
		const { tool, shop, urls } = setup();
		const none = await tool("product_search").run({ urls: [urls.blog] }, ctx());
		expect(none).toMatchObject({ ok: false, error: expect.stringContaining("No product with structured data") });
		expect(shop.productCards).toHaveLength(0);
		const partial = await tool("product_search").run({ urls: [urls.a, "https://offline.test/x"] }, ctx());
		expect(partial.ok && partial.summary).toContain("Not read (1)");
	});
	it("valida os args: precisa de query ou urls; SSRF e esquema perigoso são barrados antes da rede", async () => {
		const { tool, shop } = setup();
		expect(await tool("product_search").run({}, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("query or urls") });
		for (const bad of ["http://169.254.169.254/latest", "http://localhost/x", "file:///etc/passwd", "https://10.0.0.1/p"]) {
			expect(await tool("product_search").run({ urls: [bad] }, ctx())).toMatchObject({ ok: false });
		}
		expect(await tool("product_search").run({ urls: ["https://a.test/"], extra: 1 }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field") });
		expect(shop.fetched).toHaveLength(0);
	});
	it("resultado de busca com URL interna é ignorado, nunca lido", async () => {
		const { shop, tool } = setup();
		const cap = createShoppingCapability({ ...shop.ports, search: new FakeSearch([{ title: "x", url: "http://127.0.0.1/admin", snippet: "" }, { title: "ok", url: "https://loja-a.test/p/fone", snippet: "" }]) });
		await cap.tools.find((t) => t.name === tool("product_search").name)!.run({ query: "fone" }, ctx());
		expect(shop.fetched.map((f) => f.url)).toEqual(["https://loja-a.test/p/fone"]);
	});
});

describe("record_purchase e o vigia de entrega", () => {
	const buy = { merchant: "Loja B", items: [{ name: "Fone X", quantity: 1, unitPrice: 120 }], total: 120, currency: "BRL", orderNumber: "B-77", trackingCode: "BR999" };

	it("grava, mostra o card e cria sozinho um vigia de ~30 dias a cada 12h, ligado à compra", async () => {
		const { tool, shop, agenda } = setup();
		const out = await tool("record_purchase").run(buy, ctx());
		expect(out).toMatchObject({ ok: true, receipt: { where: "Compras", externalId: "pur-1" } });
		expect(out.ok && out.summary).toContain("Do not announce it");
		expect(shop.purchaseCards).toHaveLength(1);
		const [item] = [...agenda.items.values()];
		expect(item).toMatchObject({ kind: "watch", userId: "o1", everyMinutes: 720, status: "pending" });
		expect(item!.note).toContain("order B-77");
		expect(item!.note).toContain("tracking code BR999");
		expect(item!.note).toContain("When it is delivered, finish with done");
		expect(new Date(item!.untilAt!).toISOString()).toBe("2026-12-05T12:00:00.000Z");
		expect(shop.rows[0]!.deliveryWatchId).toBe(item!.id);
	});
	it("o mesmo pedido duas vezes não duplica compra nem vigia", async () => {
		const { tool, shop, agenda } = setup();
		await tool("record_purchase").run(buy, ctx());
		const again = await tool("record_purchase").run(buy, ctx());
		expect(again.ok && again.summary).toContain("Already saved");
		expect(shop.rows).toHaveLength(1);
		expect(agenda.items.size).toBe(1);
	});
	it("duas compras de lojas e itens diferentes geram dois vigias (a nota parecida não engole a segunda)", async () => {
		const { tool, shop, agenda } = setup();
		await tool("record_purchase").run(buy, ctx());
		const second = await tool("record_purchase").run({ merchant: "Loja Z", items: [{ name: "Teclado mecânico", quantity: 1 }], total: 300, currency: "BRL", orderNumber: "Z-9" }, ctx());
		expect(second.ok && second.summary).toContain("Do not announce it");
		expect(agenda.items.size).toBe(2);
		const watches = shop.rows.map((r) => r.deliveryWatchId);
		expect(new Set(watches).size).toBe(2);
		expect(watches.every(Boolean)).toBe(true);
	});
	it("mesmo pedido de novo com rastreio novo: mescla na compra e mantém um vigia só; se o vigia acabou, recria", async () => {
		const { tool, shop, agenda } = setup();
		const noTrack = { merchant: "Loja B", items: [{ name: "Fone X", quantity: 1 }], total: 120, currency: "BRL" };
		await tool("record_purchase").run(noTrack, ctx());
		const again = await tool("record_purchase").run({ ...noTrack, trackingCode: "BR555", trackingUrl: "https://rastreio.test/BR555" }, ctx());
		expect(again.ok && again.summary).toContain("Already saved");
		expect(shop.rows).toHaveLength(1);
		expect(shop.rows[0]).toMatchObject({ trackingCode: "BR555", trackingUrl: "https://rastreio.test/BR555" });
		expect(agenda.items.size).toBe(1);
		// o vigia acaba (entregue): o mesmo pedido de novo recria
		const [first] = [...agenda.items.values()];
		await agenda.change("o1", first!.id, "cancel");
		await tool("record_purchase").run(noTrack, ctx());
		expect(agenda.items.size).toBe(2);
		expect(shop.rows[0]!.deliveryWatchId).not.toBe(first!.id);
	});
	it("a mesma compra informada às 22h no Brasil é uma linha só; pedidos de itens diferentes no mesmo dia são duas", async () => {
		const sp = new FakeAgenda({ ...DEFAULT_PROACTIVE_SETTINGS, enabled: true, timezone: "America/Sao_Paulo" });
		const shop = new FakeShopping();
		const cap = createShoppingCapability({ ...shop.ports, search: new FakeSearch([]), agenda: sp });
		const record = cap.tools.find((t) => t.name === "record_purchase")!;
		const item = (name: string) => ({ merchant: "Loja B", items: [{ name, quantity: 1 }], total: 50, currency: "BRL", followDelivery: false });
		await record.run({ ...item("Fone X"), purchasedAt: "2026-11-05T01:00:00Z" }, ctx());
		await record.run({ ...item("Fone X"), purchasedAt: "2026-11-04T13:00:00Z" }, ctx());
		expect(shop.rows).toHaveLength(1);
		await record.run({ ...item("Mouse"), purchasedAt: "2026-11-04T13:00:00Z" }, ctx());
		expect(shop.rows).toHaveLength(2);
	});
	it("followDelivery false não cria vigia; sem agenda a compra fica salva e a tool diz", async () => {
		const { tool, agenda, shop, search } = setup();
		await tool("record_purchase").run({ ...buy, orderNumber: "D-1", followDelivery: false }, ctx());
		expect(agenda.items.size).toBe(0);
		const noAgenda = createShoppingCapability({ ...shop.ports, search }).tools.find((t) => t.name === "record_purchase")!;
		const out = await noAgenda.run({ ...buy, orderNumber: "D-2" }, ctx());
		expect(out.ok && out.summary).toContain("agenda unavailable");
		expect(shop.rows).toHaveLength(2);
	});
	it("agenda cheia: a compra fica salva e o resumo diz que o vigia não nasceu", async () => {
		const { tool, shop, agenda } = setup();
		for (let i = 0; i < 20; i += 1) await agenda.create("o1", { kind: "watch", note: `item ${i} zzz${i}`, dueAt: new Date(`2027-0${(i % 9) + 1}-10T10:00:00Z`), requestedFor: new Date(), intervalMinutes: 300 + i, untilAt: null, maxRuns: null, eventFilter: null, adjustments: [] }, { sourceRunId: "r" });
		const out = await tool("record_purchase").run(buy, ctx());
		expect(out.ok && out.summary).toContain("delivery follow-up could not be created");
		expect(shop.rows).toHaveLength(1);
	});
	it("run que leu conteúdo de fora: o vigia nasce marcado como contaminado (a nota entra como dado)", async () => {
		const { tool, agenda } = setup();
		await tool("record_purchase").run(buy, ctx({ untrustedReadInRun: true }));
		expect([...agenda.items.values()][0]).toMatchObject({ noteUntrusted: true });
	});
	it("valida: moeda, total, data futura, link perigoso e campo desconhecido viram erro com dica", async () => {
		const { tool, shop } = setup();
		expect(await tool("record_purchase").run({ ...buy, currency: "R$" }, ctx())).toMatchObject({ ok: false });
		expect(await tool("record_purchase").run({ ...buy, purchasedAt: "2030-01-01" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("future") });
		expect(await tool("record_purchase").run({ ...buy, trackingUrl: "javascript:alert(1)" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("trackingUrl") });
		expect(await tool("record_purchase").run({ ...buy, cvv: "123" }, ctx())).toMatchObject({ ok: false, error: expect.stringContaining("Unknown field") });
		expect(shop.rows).toHaveLength(0);
	});
	it("isolamento: purchase_list só devolve as compras do dono do run", async () => {
		const { tool } = setup();
		await tool("record_purchase").run(buy, ctx({ ownerId: "o1" }));
		const mine = await tool("purchase_list").run({}, ctx({ ownerId: "o1" }));
		const other = await tool("purchase_list").run({}, ctx({ ownerId: "o2" }));
		expect(mine.ok && mine.summary).toContain("Loja B");
		expect(other).toMatchObject({ ok: true, summary: "No purchases recorded yet." });
	});
});
