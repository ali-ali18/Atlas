/**
 * Entregas do v4 no worker, com db e renderizador falsos (sem banco, Chromium nem rede).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/deliverables.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChartSpec, ComputerUseEvent, CreateFileInput, PageSpec } from "@workspace/shared";
import { INSPECT_PAGE_CHARS, INSPECT_PAGE_ROWS, createV4Deliverables, htmlToPlainText, type V4DeliverablesDeps } from "./deliverables.js";

type Stored = { id: string; userId: string; kind: string; runId?: string | null; conversationId?: string | null; meta: Record<string, unknown>; bytes: Uint8Array };

function harness(options: { preview?: Awaited<ReturnType<V4DeliverablesDeps["preview"]>>; filesInRun?: number; botId?: string | null; conversationId?: string | null } = {}) {
	const artifacts = new Map<string, Stored>();
	const cards: Array<{ conversationId: string; event: ComputerUseEvent }> = [];
	const emitted: ComputerUseEvent[] = [];
	const pages: Array<{ userId: string; input: { botId: string; conversationId?: string | null } }> = [];
	const deps: V4DeliverablesDeps = {
		persistArtifact: (async (input: Omit<Stored, "id">) => {
			const id = `art-${artifacts.size + 1}`;
			artifacts.set(id, { id, ...input });
			return { id, kind: input.kind, meta: { ...input.meta, mime: "x", size: input.bytes.byteLength }, runId: input.runId ?? null, conversationId: input.conversationId ?? null, createdAt: new Date() };
		}) as unknown as V4DeliverablesDeps["persistArtifact"],
		nextVersion: async () => 1,
		countRunFiles: async () => options.filesInRun ?? 0,
		// Como o db real: só devolve o que é do dono.
		loadArtifact: async (id, userId) => {
			const found = artifacts.get(id);
			return found && found.userId === userId ? found : null;
		},
		createPage: (async (userId: string, input: { botId: string; conversationId?: string | null; spec: PageSpec }) => {
			pages.push({ userId, input });
			return { id: "page-1", botId: input.botId, conversationId: null, groupId: null, title: input.spec.title, spec: input.spec, sources: [], revision: 1, refreshedAt: null, createdAt: "", updatedAt: "" };
		}) as unknown as V4DeliverablesDeps["createPage"],
		render: async (input: CreateFileInput) => ({ bytes: new TextEncoder().encode(input.content ?? ""), mime: "text/markdown", ext: input.ext }),
		preview: async () => options.preview ?? { kind: "text", text: "conteúdo", language: "text", truncated: false },
		persistCard: async (conversationId, event) => void cards.push({ conversationId, event }),
	};
	const conversationId = options.conversationId === undefined ? "conv-1" : options.conversationId;
	const built = createV4Deliverables({ runId: "run-1", scope: { conversationId, botId: options.botId === undefined ? "bot-1" : options.botId, emit: (event) => void emitted.push(event) }, deps });
	return { ...built, deps, artifacts, cards, emitted, pages };
}

const fileInput = (over: Partial<CreateFileInput> = {}): CreateFileInput => ({ filename: "nota.md", format: "text", ext: "md", content: "# Oi", ...over });

test("arquivo: renderiza, grava como artefato do dono, grava o cartão e emite o evento", async () => {
	const h = harness();
	const file = await h.ports.files.create("user-a", "run-1", fileInput());
	assert.deepEqual(file, { id: "art-1", name: "nota.md", bytes: 4, version: 1 });
	const stored = h.artifacts.get("art-1");
	assert.equal(stored?.userId, "user-a");
	assert.equal(stored?.runId, "run-1");
	assert.equal(stored?.conversationId, "conv-1");
	assert.equal(stored?.kind, "file");
	assert.equal(h.cards.length, 1);
	assert.equal(h.cards[0]?.conversationId, "conv-1");
	assert.equal(h.cards[0]?.event.type, "file");
	assert.deepEqual(h.emitted, h.cards.map((c) => c.event));
});

test("arquivo: limite por run, imagem em slide e modelo .pptx falham com motivo (nada gravado)", async () => {
	await assert.rejects(harness({ filesInRun: 5 }).ports.files.create("user-a", "run-1", fileInput()), /File limit reached/);
	const h = harness();
	await assert.rejects(h.ports.files.create("user-a", "run-1", fileInput({ format: "pptx", ext: "pptx", slides: [{ layout: "image", title: "x", image: "img-1" } as never] })), /Images inside slides are not available yet/);
	await assert.rejects(h.ports.files.create("user-a", "run-1", fileInput({ format: "pptx", ext: "pptx", templateFileId: "t1" })), /template is not available yet/);
	assert.equal(h.artifacts.size, 0);
});

test("inspect: arquivo do dono volta com o texto; de OUTRO dono e inexistente dão o mesmo null (IDOR)", async () => {
	const h = harness();
	const { id } = await h.ports.files.create("user-a", "run-1", fileInput());
	const own = await h.ports.files.inspect("user-a", id);
	assert.equal(own?.text, "conteúdo");
	assert.equal(own?.name, "nota.md");
	assert.equal(await h.ports.files.inspect("user-b", id), null);
	assert.equal(await h.ports.files.inspect("user-a", "nao-existe"), null);
	assert.equal(await h.ports.files.inspect("user-b", "nao-existe"), null);
});

test("inspect: só artefato do tipo arquivo; planilha, docx e binário", async () => {
	const h = harness();
	h.artifacts.set("shot", { id: "shot", userId: "user-a", kind: "screenshot", meta: {}, bytes: new Uint8Array(1) });
	assert.equal(await h.ports.files.inspect("user-a", "shot"), null);

	const sheet = harness({ preview: { kind: "sheets", sheets: [{ name: "A", rows: [["1", "2"]], truncated: true }] } });
	const created = await sheet.ports.files.create("user-a", "run-1", fileInput({ filename: "p.xlsx", format: "xlsx", ext: "xlsx" }));
	const view = await sheet.ports.files.inspect("user-a", created.id);
	assert.deepEqual(view?.sheets, [{ name: "A", rows: [["1", "2"]], startRow: 1, totalRows: 1, truncated: false }]);
	assert.equal(view?.truncated, false);

	const docx = harness({ preview: { kind: "html", html: "<h1>Título</h1><p>Um &amp; dois</p>" } });
	const doc = await docx.ports.files.create("user-a", "run-1", fileInput({ filename: "d.docx", format: "docx", ext: "docx" }));
	assert.equal((await docx.ports.files.inspect("user-a", doc.id))?.text, "Título\nUm & dois");

	const pdf = harness({ preview: { kind: "url", url: "/v1/files/x" } });
	const pdfFile = await pdf.ports.files.create("user-a", "run-1", fileInput({ filename: "p.pdf", format: "pdf", ext: "pdf" }));
	assert.match((await pdf.ports.files.inspect("user-a", pdfFile.id))?.text ?? "", /No text can be read/);
});

test("painel: grava com o dono e o bot do run e mostra o cartão; sem bot falha com o motivo", async () => {
	const h = harness();
	const spec = { v: 2, title: "Vendas", root: { type: "section" } } as unknown as PageSpec;
	assert.deepEqual(await h.ports.pages.save("user-a", "run-1", spec), { id: "page-1", title: "Vendas" });
	assert.deepEqual(h.pages.map((p) => ({ userId: p.userId, botId: p.input.botId, conversationId: p.input.conversationId })), [{ userId: "user-a", botId: "bot-1", conversationId: "conv-1" }]);
	assert.equal(h.cards[0]?.event.type, "page");
	await assert.rejects(harness({ botId: null }).ports.pages.save("user-a", "run-1", spec), /belong to a bot/);
});


test("gráfico: id estável pelo conteúdo (refazer não duplica o cartão) e exige conversa", async () => {
	const h = harness();
	const spec = { type: "bar", x: "m", series: [{ key: "v", label: "V" }], data: [{ m: "jan", v: 1 }] } as unknown as ChartSpec;
	const first = await h.ports.charts.save("user-a", "run-1", spec);
	const again = await h.ports.charts.save("user-a", "run-1", spec);
	const other = await h.ports.charts.save("user-a", "run-1", { ...spec, title: "Outro" } as ChartSpec);
	assert.equal(first.id, again.id);
	assert.notEqual(first.id, other.id);
	assert.match(first.id, /^run-1:chart:[0-9a-f]{12}$/);
	// Chamado de novo no mesmo run: uma gravação e um evento por gráfico distinto (auditoria F2, B3/T1).
	assert.equal(h.cards.filter((c) => c.event.type === "chart").length, 2);
	assert.equal(h.emitted.filter((e) => e.type === "chart").length, 2);
	await assert.rejects(harness({ conversationId: null }).ports.charts.save("user-a", "run-1", spec), /in the conversation/);
});

test("FileStore simples grava o texto como arquivo do dono", async () => {
	const h = harness();
	const stored = await h.fileStore.put("user-a", { name: "a.txt", mimeType: "text/plain", content: "abc" });
	assert.deepEqual(stored, { id: "art-1", name: "a.txt", bytes: 3 });
	assert.equal(h.artifacts.get("art-1")?.userId, "user-a");
});

test("htmlToPlainText tira tags e entidades", () => {
	assert.equal(htmlToPlainText("<p>a&nbsp;b</p><ul><li>x</li></ul>"), "a b\nx");
});

test("painel: createPage devolvendo null (bot de outro dono) vira erro, sem cartão", async () => {
	const h = harness();
	const deps = { ...(await import("./deliverables.js")).realV4DeliverablesDeps, createPage: (async () => null) as unknown as V4DeliverablesDeps["createPage"], persistCard: async () => assert.fail("sem cartão") };
	const none = createV4Deliverables({ runId: "run-1", scope: { conversationId: "conv-1", botId: "bot-de-outro", emit: () => undefined }, deps });
	await assert.rejects(none.ports.pages.save("user-a", "run-1", { v: 2, title: "x", root: {} } as unknown as PageSpec), /Could not create the panel/);
	assert.equal(h.cards.length, 0);
});

test("cartão que falha ao gravar vai ao log e não derruba a entrega (auditoria F2, B4/R3)", async () => {
	const logs: string[] = [];
	const emitted: ComputerUseEvent[] = [];
	const deps = { ...harness().deps, persistCard: async () => { throw new Error("db fora do ar"); } };
	const built = createV4Deliverables({ runId: "run-1", scope: { conversationId: "conv-1", botId: "bot-1", emit: (e) => void emitted.push(e), log: (m) => void logs.push(m) }, deps });
	const spec = { type: "bar", x: "m", series: [{ key: "v", label: "V" }], data: [{ m: "jan", v: 1 }] } as unknown as ChartSpec;
	await built.ports.charts.save("user-a", "run-1", spec);
	assert.equal(emitted.length, 1);
	assert.equal(logs.length, 1);
	assert.match(logs[0] ?? "", /chart.*db fora do ar/);
});

test("htmlToPlainText decodifica entidades numéricas e nomeadas e mantém as quebras (auditoria F2, R2)", () => {
	assert.equal(htmlToPlainText("<p>It&#39;s 1 &ndash; 2 &amp; &lt;b&gt;</p><p>fim&nbsp;ok</p>"), "It's 1 – 2 & <b>\nfim ok");
});

test("inspect em partes: duas leituras de texto cobrem o arquivo inteiro, sem corte (auditoria F2, C2)", async () => {
	const full = Array.from({ length: INSPECT_PAGE_CHARS + 5000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
	const h = harness({ preview: { kind: "text", text: full, language: "text", truncated: false } });
	const { id } = await h.ports.files.create("user-a", "run-1", fileInput());
	const first = await h.ports.files.inspect("user-a", id);
	assert.deepEqual(first?.textRange, { start: 0, end: INSPECT_PAGE_CHARS, total: full.length });
	assert.equal(first?.truncated, true);
	const second = await h.ports.files.inspect("user-a", id, { offset: first?.textRange?.end });
	assert.deepEqual(second?.textRange, { start: INSPECT_PAGE_CHARS, end: full.length, total: full.length });
	assert.equal(second?.truncated, false);
	assert.equal((first?.text ?? "") + (second?.text ?? ""), full);
	await assert.rejects(h.ports.files.inspect("user-a", id, { offset: full.length }), /past the end/);
	await assert.rejects(h.ports.files.inspect("user-a", id, { sheet: "A" }), /spreadsheets only/);
});

test("inspect em partes: planilha por aba e faixa de linhas; aba inexistente lista as abas", async () => {
	const rows = Array.from({ length: INSPECT_PAGE_ROWS + 50 }, (_, i) => [String(i + 1)]);
	const h = harness({ preview: { kind: "sheets", sheets: [{ name: "Dados", rows, truncated: false }, { name: "Outra", rows: [["x"]], truncated: false }] } });
	const { id } = await h.ports.files.create("user-a", "run-1", fileInput({ filename: "p.xlsx", format: "xlsx", ext: "xlsx" }));
	const all = await h.ports.files.inspect("user-a", id);
	assert.deepEqual(all?.sheets?.map((s) => [s.name, s.rows.length, s.truncated]), [["Dados", INSPECT_PAGE_ROWS, true], ["Outra", 1, false]]);
	const rest = await h.ports.files.inspect("user-a", id, { sheet: "Dados", startRow: INSPECT_PAGE_ROWS + 1 });
	assert.equal(rest?.sheets?.[0]?.rows.length, 50);
	assert.equal(rest?.sheets?.[0]?.rows[0]?.[0], String(INSPECT_PAGE_ROWS + 1));
	assert.equal(rest?.truncated, false);
	const covered = [...(all?.sheets?.[0]?.rows ?? []), ...(rest?.sheets?.[0]?.rows ?? [])];
	assert.deepEqual(covered, rows);
	await assert.rejects(h.ports.files.inspect("user-a", id, { sheet: "Nada" }), /Sheets: Dados, Outra/);
	await assert.rejects(h.ports.files.inspect("user-a", id, { offset: 3 }), /text files only/);
});
