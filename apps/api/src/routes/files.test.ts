/**
 * F9/F14 — GET /v1/files/:id e /preview: dono baixa, outro usuário recebe 404
 * (IDOR), headers de segurança e prévia por tipo. Prisma dublado em memória
 * (mesma técnica de scope.test.ts); os arquivos vão para um diretório temporário.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_ARTIFACT_DIR = await mkdtemp(join(tmpdir(), "atlas-files-test-"));

const { Hono } = await import("hono");
const { prisma, persistUserArtifact } = await import("@workspace/db");
const { renderFile } = await import("@workspace/agent-runtime");
const { parseCreateFileArgs } = await import("@workspace/shared");
const { createFileRoutes } = await import("./files.js");

const USER_A = "user-a-files";
const USER_B = "user-b-files";

type Row = { id: string; userId: string | null; runId: string | null; conversationId: string | null; kind: string; uri: string; metaJson: unknown; createdAt: Date };
const rows = new Map<string, Row>();
let seq = 0;

const artifact = prisma.artifact as unknown as Record<string, unknown>;
artifact.create = async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
	const row: Row = { ...data, id: `art-${++seq}`, createdAt: new Date() };
	rows.set(row.id, row);
	return row;
};
artifact.update = async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
	const row = rows.get(where.id)!;
	Object.assign(row, data);
	return row;
};
artifact.delete = async ({ where }: { where: { id: string } }) => {
	rows.delete(where.id);
};
// Honra o filtro de dono da query real: id + (userId in owners | legado sem userId).
artifact.findFirst = async ({ where }: { where: { id: string; OR: Array<{ userId: { in: string[] } | null }> } }) => {
	const row = rows.get(where.id);
	if (!row) return null;
	const owned = where.OR.some((clause) => {
		const cond = clause.userId;
		return cond && typeof cond === "object" && "in" in cond ? row.userId !== null && cond.in.includes(row.userId) : false;
	});
	return owned ? row : null;
};

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createFileRoutes());
	return app;
}

async function createFile(userId: string, args: Record<string, unknown>) {
	const input = parseCreateFileArgs(args);
	const out = await renderFile(input, { printPdf: async () => new TextEncoder().encode("%PDF-1.4 fake") });
	const stored = await persistUserArtifact({
		userId,
		kind: "file",
		bytes: out.bytes,
		mime: out.mime,
		meta: { filename: input.filename, format: input.format, ext: out.ext, version: 1 },
	});
	return { id: stored.id, bytes: out.bytes, mime: out.mime, filename: input.filename };
}

test("dono baixa o arquivo com Content-Type, Disposition e headers de segurança", async () => {
	const file = await createFile(USER_A, { filename: "Relatório PVU.docx", content: "# Oi" });
	const res = await appFor(USER_A).request(`/v1/files/${file.id}`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), file.mime);
	const disposition = res.headers.get("content-disposition") ?? "";
	assert.match(disposition, /^attachment; filename="Relat_rio PVU.docx"; filename\*=UTF-8''Relat%C3%B3rio%20PVU\.docx$/);
	assert.equal(res.headers.get("x-content-type-options"), "nosniff");
	assert.match(res.headers.get("cache-control") ?? "", /^private/);
	assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(file.bytes));
});

test("outro usuário recebe 404 no download e na prévia (IDOR)", async () => {
	const file = await createFile(USER_A, { filename: "segredo.txt", content: "so do A" });
	const download = await appFor(USER_B).request(`/v1/files/${file.id}`);
	assert.equal(download.status, 404);
	assert.doesNotMatch(await download.text(), /so do A/);
	assert.equal((await appFor(USER_B).request(`/v1/files/${file.id}/preview`)).status, 404);
	assert.equal((await appFor(USER_A).request("/v1/files/nao-existe")).status, 404);
});

test("?inline=1 só vale para PDF/imagem; html e svg continuam como anexo", async () => {
	const pdf = await createFile(USER_A, { filename: "a.pdf", content: "x" });
	const inlinePdf = await appFor(USER_A).request(`/v1/files/${pdf.id}?inline=1`);
	assert.match(inlinePdf.headers.get("content-disposition") ?? "", /^inline;/);
	const html = await createFile(USER_A, { filename: "a.html", content: "<script>alert(1)</script>" });
	const inlineHtml = await appFor(USER_A).request(`/v1/files/${html.id}?inline=1`);
	assert.match(inlineHtml.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("prévia por tipo: texto, docx, xlsx e pdf", async () => {
	const app = appFor(USER_A);
	const py = await createFile(USER_A, { filename: "r.py", content: "print(1)\n" });
	assert.deepEqual(await (await app.request(`/v1/files/${py.id}/preview`)).json(), {
		kind: "text", text: "print(1)\n", language: "python", truncated: false,
	});

	const docx = await createFile(USER_A, { filename: "d.docx", content: "# Título\n\n| A | B |\n|---|---|\n| 1 | 2 |\n" });
	const docxPreview = (await (await app.request(`/v1/files/${docx.id}/preview`)).json()) as { kind: string; html: string };
	assert.equal(docxPreview.kind, "html");
	assert.match(docxPreview.html, /Título/);
	assert.match(docxPreview.html, /<table>/);

	const xlsx = await createFile(USER_A, { filename: "p.xlsx", sheets: [{ name: "S", columns: ["a"], rows: [["x"]] }] });
	const xlsxPreview = (await (await app.request(`/v1/files/${xlsx.id}/preview`)).json()) as { kind: string; sheets: Array<{ rows: string[][] }> };
	assert.equal(xlsxPreview.kind, "sheets");
	assert.deepEqual(xlsxPreview.sheets[0]?.rows, [["a"], ["x"]]);

	const pdf = await createFile(USER_A, { filename: "x.pdf", content: "x" });
	assert.deepEqual(await (await app.request(`/v1/files/${pdf.id}/preview`)).json(), {
		kind: "url", url: `/v1/files/${pdf.id}?inline=1`,
	});
});

test("GET /v1/bots/:botId/artifacts: dono lista; bot de outro dono vira 404; cursor inválido 400", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: USER_A } });
		await next();
	});
	app.route("/", createFileRoutes({
		listBotArtifacts: async (input) => {
			calls.push(input as unknown as Record<string, unknown>);
			if (input.botId !== "bot-a") return null;
			return { files: [{ id: "x1", filename: "a.pdf", size: 10, version: 1, mime: "application/pdf", createdAt: "2026-01-01T00:00:00.000Z" }], nextCursor: null };
		},
	}));
	const ok = await app.request("/v1/bots/bot-a/artifacts?limit=5");
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { files: unknown[] }).files.length, 1);
	assert.equal(calls[0]!.userId, USER_A);
	assert.equal(calls[0]!.limit, 5);
	assert.equal((await app.request("/v1/bots/bot-b/artifacts")).status, 404);
	assert.equal((await app.request("/v1/bots/bot-a/artifacts?cursor=lixo")).status, 400);
});
