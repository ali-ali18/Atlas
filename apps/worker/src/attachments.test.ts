import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExtractPool, type Extractor } from "@workspace/agent-runtime";
import { attachmentRuntimeForRun, warmAttachmentExtract } from "./attachments.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 100 Td (Texto do PDF) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF");
const CSV = Buffer.from("nome,idade\nAna,30\nBia,25\n");

const metas = [
	{ artifactId: "pdf1", filename: "contrato.pdf", mime: "application/pdf", size: PDF.byteLength, kind: "pdf" as const },
	{ artifactId: "csv1", filename: "pessoas.csv", mime: "text/csv", size: CSV.byteLength, kind: "csv" as const },
];
const stored = new Map<string, Buffer>([["pdf1", PDF], ["csv1", CSV]]);

/** Cache em disco dublado: chave por id (a tabela de artefatos não existe nos testes). */
function sidecars(disk = new Map<string, string>()) {
	return {
		disk,
		readSidecar: async (id: string, _userId: string, name: string) => disk.get(`${id}.${name}`) ?? null,
		writeSidecar: async (id: string, _userId: string, name: string, content: string) => { disk.set(`${id}.${name}`, content); return true; },
	};
}

function deps(owner = "user-a", history = metas, disk = sidecars()) {
	return {
		readSidecar: disk.readSidecar,
		writeSidecar: disk.writeSidecar,
		loadHistory: async (_conversationId: string, userId: string) => (userId === owner ? history : []),
		loadMetas: async (ids: string[], userId: string) => (userId === owner ? metas.filter((meta) => ids.includes(meta.artifactId)) : []),
		loadArtifact: async (id: string, userId: string) => {
			const bytes = stored.get(id);
			return bytes && userId === owner ? ({ id, kind: "file", bytes, meta: { mime: "x", origin: "user" } } as never) : null;
		},
	};
}

const base = { userId: "user-a", conversationId: "conv-1", currentIds: ["pdf1", "csv1"], fresh: true };

test("modelo com PDF nativo (Anthropic/OpenRouter): PDF vai como documento, planilha como texto", async () => {
	for (const model of ["anthropic-direct/claude-sonnet-4-5", "anthropic/claude-sonnet-4.5", "openai/gpt-5"]) {
		const { runtime } = await attachmentRuntimeForRun({ ...base, model, deps: deps() });
		assert.equal(runtime.canReadNativePdf, true, model);
		assert.deepEqual(runtime.nativePdfs, [{ id: "pdf1", filename: "contrato.pdf" }], model);
		assert.match(runtime.turnContext ?? "", /attached to this message as a document/);
		assert.match(runtime.turnContext ?? "", /\| nome \| idade \|/);
	}
});

test("ChatGPT, OpenCode Go e demais: PDF extraído no servidor e enviado como texto", async () => {
	for (const model of ["chatgpt/gpt-5", "opencode-go/glm-4.6", "deepseek/deepseek-chat"]) {
		const { runtime } = await attachmentRuntimeForRun({ ...base, model, deps: deps() });
		assert.equal(runtime.canReadNativePdf, false, model);
		assert.equal(runtime.nativePdfs, undefined, model);
		assert.match(runtime.turnContext ?? "", /Texto do PDF/, model);
	}
});

test("retomada (checkpoint com mensagens) não remonta o contexto; a lista da conversa continua disponível", async () => {
	const { runtime, historyNote } = await attachmentRuntimeForRun({ ...base, fresh: false, model: "chatgpt/gpt-5", deps: deps() });
	assert.equal(runtime.turnContext, undefined);
	assert.equal(historyNote, null);
	assert.equal(runtime.present, true);
	assert.deepEqual((await runtime.list()).map((ref) => ref.id), ["pdf1", "csv1"]);
});

test("turno novo sem arquivos novos: só a nota com os anexos anteriores", async () => {
	const { runtime, historyNote } = await attachmentRuntimeForRun({ ...base, currentIds: [], model: "chatgpt/gpt-5", deps: deps() });
	assert.equal(runtime.turnContext, undefined);
	assert.match(historyNote ?? "", /"contrato\.pdf" \(PDF/);
	assert.match(historyNote ?? "", /id pdf1/);
});

test("dono: outro usuário não vê lista nem bytes; PDF nativo só carrega anexo permitido do dono", async () => {
	const other = await attachmentRuntimeForRun({ ...base, userId: "user-b", model: "anthropic-direct/x", deps: deps() });
	assert.equal(other.runtime.present, false);
	assert.deepEqual(await other.runtime.list(), []);
	const { runtime } = await attachmentRuntimeForRun({ ...base, model: "anthropic-direct/x", deps: deps() });
	assert.match((await runtime.loadPdfDataUrl("pdf1")) ?? "", /^data:application\/pdf;base64,/);
	assert.equal(await runtime.loadPdfDataUrl("csv1"), null);
	assert.equal(await runtime.loadPdfDataUrl("de-outro"), null);
});

test("falha ao carregar não derruba: arquivo sumido vira aviso no contexto", async () => {
	const missing = { ...deps(), loadArtifact: async () => null };
	const { runtime } = await attachmentRuntimeForRun({ ...base, model: "chatgpt/gpt-5", deps: missing });
	assert.match(runtime.turnContext ?? "", /no longer available/);
});

function countingExtractor(real: Extractor) {
	const calls = { extract: 0 };
	const extractor: Extractor = { extract: async (input) => { calls.extract += 1; return real.extract(input); }, pageCount: (bytes) => real.pageCount(bytes) };
	return { extractor, calls };
}

const pool = new ExtractPool({ size: 1 });
after(async () => { await pool.close(); });

test("a leitura roda na worker thread do pool (não no processo) e o resultado fica em cache no disco", async () => {
	const disk = sidecars();
	const first = countingExtractor(pool);
	const a = await attachmentRuntimeForRun({ ...base, model: "chatgpt/gpt-5", deps: { ...deps("user-a", metas, disk), extractor: first.extractor } });
	assert.match(a.runtime.turnContext ?? "", /Texto do PDF/);
	assert.equal(first.calls.extract, 2);
	assert.ok(disk.disk.has("pdf1.extract") && disk.disk.has("csv1.extract"));
	assert.ok(pool.threads >= 1);

	// Outro run (processo novo, mesmo disco): não extrai de novo.
	const second = countingExtractor(pool);
	const b = await attachmentRuntimeForRun({ ...base, model: "chatgpt/gpt-5", deps: { ...deps("user-a", metas, disk), extractor: second.extractor } });
	assert.equal(second.calls.extract, 0);
	assert.equal(b.runtime.turnContext, a.runtime.turnContext);
});

test("cache em disco corrompido ou de outra versão é ignorado e reextraído", async () => {
	const disk = sidecars(new Map([["pdf1.extract", "{nao e json"], ["csv1.extract", JSON.stringify({ v: 999, extracted: {} })]]));
	const run = countingExtractor(pool);
	const { runtime } = await attachmentRuntimeForRun({ ...base, model: "chatgpt/gpt-5", deps: { ...deps("user-a", metas, disk), extractor: run.extractor } });
	assert.equal(run.calls.extract, 2);
	assert.match(runtime.turnContext ?? "", /Texto do PDF/);
});

test("arquivo que trava a thread é morto no prazo e vira nota para o modelo, sem derrubar o run", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extract-hang-"));
	const entry = join(dir, "hang.mjs");
	await writeFile(entry, ['import { parentPort } from "node:worker_threads";', 'parentPort.on("message", () => { for (;;) {} });'].join("\n"));
	const hung = new ExtractPool({ entry, timeoutMs: 400, size: 1 });
	try {
		const disk = sidecars();
		const startedAt = Date.now();
		const { runtime } = await attachmentRuntimeForRun({ ...base, currentIds: ["csv1"], model: "chatgpt/gpt-5", deps: { ...deps("user-a", metas, disk), extractor: hung } });
		assert.ok(Date.now() - startedAt < 5_000);
		assert.match(runtime.turnContext ?? "", /took longer than/);
		assert.equal(disk.disk.size, 0, "morto por prazo não vai para o cache");
		assert.equal(hung.threads, 0);
	} finally {
		await hung.close();
	}
});

test("pré-extração após o upload: extrai uma vez, grava ao lado do arquivo e o run seguinte já encontra pronto", async () => {
	const disk = sidecars();
	const run = countingExtractor(pool);
	const common = { ...deps("user-a", metas, disk), extractor: run.extractor };
	assert.equal(await warmAttachmentExtract({ userId: "user-a", artifactId: "pdf1", deps: common }), "extracted");
	assert.equal(await warmAttachmentExtract({ userId: "user-a", artifactId: "pdf1", deps: common }), "cached");
	assert.equal(await warmAttachmentExtract({ userId: "user-b", artifactId: "pdf1", deps: { ...common, ...deps("user-a") } }), "skipped");
	assert.equal(run.calls.extract, 1);
	const { runtime } = await attachmentRuntimeForRun({ ...base, currentIds: ["pdf1"], model: "chatgpt/gpt-5", deps: common });
	assert.match(runtime.turnContext ?? "", /Texto do PDF/);
	assert.equal(run.calls.extract, 1);
});
