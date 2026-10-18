/**
 * F14 — POST /v1/uploads/images + GET /v1/files/:id: o dono envia e baixa a
 * imagem; outro usuário não lê, não baixa e não consegue referenciá-la (404 /
 * "anexo inválido"). Prisma dublado em memória, arquivos em diretório temporário.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_ARTIFACT_DIR = await mkdtemp(join(tmpdir(), "atlas-uploads-test-"));

const { Hono } = await import("hono");
const { prisma, resolveUserImagesCard } = await import("@workspace/db");
const { createFileRoutes } = await import("./files.js");
const { createUploadRoutes } = await import("./uploads.js");

const USER_A = "user-a-upload";
const USER_B = "user-b-upload";

type Row = { id: string; userId: string | null; runId: string | null; conversationId: string | null; kind: string; uri: string; metaJson: unknown; createdAt: Date };
const rows = new Map<string, Row>();
let seq = 0;

const artifact = prisma.artifact as unknown as Record<string, unknown>;
artifact.create = async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
	const row: Row = { ...data, id: `img-${++seq}`, createdAt: new Date() };
	rows.set(row.id, row);
	return row;
};
artifact.update = async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.get(where.id)!, data);
artifact.delete = async ({ where }: { where: { id: string } }) => { rows.delete(where.id); };
artifact.findFirst = async ({ where }: { where: { id: string; OR: Array<{ userId: { in: string[] } | null }> } }) => {
	const row = rows.get(where.id);
	if (!row) return null;
	const owned = where.OR.some((clause) => {
		const cond = clause.userId;
		return cond && typeof cond === "object" && "in" in cond ? row.userId !== null && cond.in.includes(row.userId) : false;
	});
	return owned ? row : null;
};

function appFor(userId: string, enqueueExtract?: (input: { userId: string; artifactId: string }) => Promise<unknown>) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createFileRoutes());
	app.route("/", createUploadRoutes(enqueueExtract ? { enqueueExtract } : {}));
	return app;
}

// PNG 1x1 válido (o processamento com sharp roda de verdade na rota).
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function uploadPng(userId: string) {
	const png = Buffer.from(PNG_1X1, "base64");
	const form = new FormData();
	form.set("file", new File([new Uint8Array(png)], "foto.png", { type: "image/png" }));
	const res = await appFor(userId).request("/v1/uploads/images", { method: "POST", body: form });
	return { res, body: (await res.json()) as { id: string; mime: string; url: string } };
}

test("dono envia a imagem e baixa em /v1/files/:id", async () => {
	const { res, body } = await uploadPng(USER_A);
	assert.equal(res.status, 201);
	assert.equal(body.url, `/v1/files/${body.id}`);
	const download = await appFor(USER_A).request(body.url);
	assert.equal(download.status, 200);
	assert.match(download.headers.get("Content-Type") ?? "", /^image\//);
});

test("IDOR: usuário B recebe 404 ao ler, baixar ou pré-visualizar a imagem de A", async () => {
	const { body } = await uploadPng(USER_A);
	const b = appFor(USER_B);
	assert.equal((await b.request(`/v1/files/${body.id}`)).status, 404);
	assert.equal((await b.request(`/v1/files/${body.id}?inline=1`)).status, 404);
	assert.equal((await b.request(`/v1/files/${body.id}/preview`)).status, 404);
});

test("IDOR: usuário B não consegue anexar a imagem de A a uma mensagem", async () => {
	const { body } = await uploadPng(USER_A);
	assert.ok(await resolveUserImagesCard([{ artifactId: body.id }], USER_A));
	await assert.rejects(resolveUserImagesCard([{ artifactId: body.id }], USER_B), /anexo inválido/);
});

// ---- Anexos de arquivo (POST /v1/uploads/files) ----

artifact.findMany = async ({ where }: { where: { id: { in: string[] }; kind?: string; userId?: { in: string[] } } }) =>
	[...rows.values()].filter((row) => where.id.in.includes(row.id) && (!where.kind || row.kind === where.kind) && (!where.userId || (row.userId !== null && where.userId.in.includes(row.userId))));

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");

async function uploadFile(userId: string, name: string, bytes: Uint8Array | Buffer, type = "application/octet-stream") {
	const form = new FormData();
	form.set("file", new File([new Uint8Array(bytes)], name, { type }));
	const res = await appFor(userId).request("/v1/uploads/files", { method: "POST", body: form });
	return { res, body: (await res.json()) as { id?: string; error?: string; name?: string; mime?: string; kind?: string; size?: number; url?: string } };
}

test("arquivo: dono envia um PDF, o tipo vem do conteúdo e baixa como anexo", async () => {
	const { res, body } = await uploadFile(USER_A, "../../Relatório final.pdf", PDF_BYTES, "text/html");
	assert.equal(res.status, 201);
	assert.equal(body.kind, "pdf");
	assert.equal(body.mime, "application/pdf");
	assert.equal(body.name, "Relatório final.pdf");
	assert.equal(body.size, PDF_BYTES.byteLength);
	const download = await appFor(USER_A).request(body.url!);
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Content-Type"), "application/pdf");
	assert.match(download.headers.get("Content-Disposition") ?? "", /^attachment/);
	assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
});

test("arquivo: HTML e SVG nunca voltam como página (octet-stream, attachment, nosniff, sem inline)", async () => {
	for (const [name, content] of [["pagina.html", "<script>alert(1)</script>"], ["desenho.svg", "<svg onload=alert(1)></svg>"]] as const) {
		const { res, body } = await uploadFile(USER_A, name, Buffer.from(content), "text/html");
		assert.equal(res.status, 201, name);
		const download = await appFor(USER_A).request(`${body.url}?inline=1`);
		assert.equal(download.headers.get("Content-Type"), "application/octet-stream", name);
		assert.match(download.headers.get("Content-Disposition") ?? "", /^attachment/, name);
		assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
		assert.match(download.headers.get("Content-Security-Policy") ?? "", /sandbox/);
	}
});

test("arquivo: limite de 20 MB, vazio e extensão que não confere com o conteúdo", async () => {
	const big = await uploadFile(USER_A, "grande.bin", Buffer.alloc(20 * 1024 * 1024 + 1, 1));
	assert.equal(big.res.status, 413);
	assert.equal((await uploadFile(USER_A, "vazio.txt", Buffer.alloc(0))).res.status, 400);
	const fake = await uploadFile(USER_A, "falso.pdf", Buffer.from("isto nao e pdf"));
	assert.equal(fake.res.status, 415);
	assert.equal((await uploadFile(USER_A, "falso.docx", Buffer.from("texto"))).res.status, 415);
	const ok = await uploadFile(USER_A, "dados.bin", Buffer.from([0, 1, 2, 3, 0xff]));
	assert.equal(ok.res.status, 201);
	assert.equal(ok.body.kind, "other");
});

test("arquivo: imagem não entra pela rota de arquivo e multipart é obrigatório", async () => {
	const png = Buffer.from(PNG_1X1, "base64");
	assert.equal((await uploadFile(USER_A, "foto.png", png, "image/png")).res.status, 415);
	const res = await appFor(USER_A).request("/v1/uploads/files", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
	assert.equal(res.status, 400);
});

test("arquivo: IDOR - outro usuário recebe 404 ao baixar/pré-visualizar e não anexa o arquivo de A", async () => {
	const { body } = await uploadFile(USER_A, "segredo.txt", Buffer.from("conteudo privado"), "text/plain");
	const b = appFor(USER_B);
	assert.equal((await b.request(body.url!)).status, 404);
	assert.equal((await b.request(`${body.url}/preview`)).status, 404);
	const { resolveUserFileCards } = await import("@workspace/db");
	const cards = await resolveUserFileCards([{ artifactId: body.id! }], USER_A);
	assert.equal(cards.length, 1);
	assert.equal(cards[0]?.origin, "user");
	assert.deepEqual(await resolveUserFileCards([{ artifactId: body.id! }], USER_B), []);
});

test("arquivo: o servidor nunca executa nem interpreta o binário (preview de binário não vaza bytes)", async () => {
	const { body } = await uploadFile(USER_A, "pacote.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), "application/zip");
	const preview = await appFor(USER_A).request(`${body.url}/preview`);
	assert.equal(preview.status, 200);
	assert.equal(((await preview.json()) as { kind: string }).kind, "none");
});

test("arquivo: a API só valida e grava; a leitura vai para a fila do worker (PDF sim, binário e zip não, falha da fila não derruba)", async () => {
	const queued: Array<{ userId: string; artifactId: string }> = [];
	const form = (name: string, bytes: Uint8Array) => { const body = new FormData(); body.set("file", new File([new Uint8Array(bytes)], name)); return body; };
	const app = appFor(USER_A, async (input) => { queued.push(input); });
	const pdf = await app.request("/v1/uploads/files", { method: "POST", body: form("a.pdf", new Uint8Array(PDF_BYTES)) });
	const id = ((await pdf.json()) as { id: string }).id;
	assert.deepEqual(queued, [{ userId: USER_A, artifactId: id }]);
	await app.request("/v1/uploads/files", { method: "POST", body: form("p.zip", Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])) });
	assert.equal(queued.length, 1);
	const broken = appFor(USER_A, async () => { throw new Error("redis fora"); });
	assert.equal((await broken.request("/v1/uploads/files", { method: "POST", body: form("b.pdf", new Uint8Array(PDF_BYTES)) })).status, 201);
});
