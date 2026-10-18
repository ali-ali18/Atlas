import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileApi, FileError } from "../server/files.mjs";
import { unifiedDiff, applyUnifiedDiff } from "../server/diff.mjs";

async function setup() {
	// Barras normais: o módulo usa path/posix, então o teste roda igual no Windows.
	const dir = (await fsp.mkdtemp(path.join(os.tmpdir(), "devws-"))).replaceAll("\\", "/");
	const api = createFileApi({ workspace: dir, confine: async (p) => path.posix.join(dir, p) });
	return { dir, api };
}

test("patch exige old único e aceita replaceAll", async () => {
	const { dir, api } = await setup();
	await fsp.writeFile(path.posix.join(dir, "a.txt"), "foo\nbar\nfoo\n");
	await assert.rejects(
		() => api.patch({ path: "a.txt", old: "foo", new: "baz" }),
		(e) => e instanceof FileError && /2 vezes/.test(e.message),
	);
	const ok = await api.patch({ path: "a.txt", old: "bar", new: "BAR" });
	assert.equal(ok.added, 1);
	assert.equal(ok.removed, 1);
	assert.match(ok.diff, /-bar/);
	assert.match(ok.diff, /\+BAR/);
	await api.patch({ path: "a.txt", old: "foo", new: "baz", replaceAll: true });
	assert.equal(await fsp.readFile(path.posix.join(dir, "a.txt"), "utf8"), "baz\nBAR\nbaz\n");
});

test("patch rejeita old ausente, vazio e igual a new", async () => {
	const { dir, api } = await setup();
	await fsp.writeFile(path.posix.join(dir, "a.txt"), "x\n");
	await assert.rejects(() => api.patch({ path: "a.txt", old: "nada", new: "y" }), /não foi encontrado/);
	await assert.rejects(() => api.patch({ path: "a.txt", old: "", new: "y" }), /vazio/);
	await assert.rejects(() => api.patch({ path: "a.txt", old: "x", new: "x" }), /iguais/);
});

test("write cria diretórios e devolve diff; read pagina por linhas", async () => {
	const { api } = await setup();
	const w = await api.write({ path: "sub/dir/n.txt", content: "1\n2\n3\n" });
	assert.equal(w.created, true);
	assert.equal(w.added, 3);
	const r = await api.read({ path: "sub/dir/n.txt", offset: 1, limit: 1 });
	assert.equal(r.content, "2");
	assert.equal(r.nextOffset, 2);
	assert.equal(r.totalLines, 3);
});

test("list ignora node_modules na descida", async () => {
	const { dir, api } = await setup();
	await fsp.mkdir(path.posix.join(dir, "node_modules/x"), { recursive: true });
	await fsp.writeFile(path.posix.join(dir, "node_modules/x/i.js"), "1");
	await fsp.writeFile(path.posix.join(dir, "main.js"), "1");
	const l = await api.list({ path: ".", depth: 3 });
	assert.ok(l.entries.some((e) => e.path === "main.js"));
	assert.ok(!l.entries.some((e) => e.path.includes("i.js")));
});

test("diff unificado aplica de volta", () => {
	const a = "l1\nl2\nl3\n";
	const b = "l1\nL2\nl3\nl4\n";
	const { diff, added, removed } = unifiedDiff(a, b, { path: "f" });
	assert.equal(added, 2);
	assert.equal(removed, 1);
	assert.equal(applyUnifiedDiff(a, diff), b);
});

test("write com encoding base64 grava os bytes exatos (anexo binário) sem diff", async () => {
	const { dir, api } = await setup();
	const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 10, 13]);
	const result = await api.write({ path: "anexos/pacote.zip", content: bytes.toString("base64"), encoding: "base64" });
	assert.equal(result.bytes, bytes.length);
	assert.equal(result.binary, true);
	assert.equal(result.diff, "");
	const onDisk = await fsp.readFile(path.posix.join(dir, "anexos/pacote.zip"));
	assert.deepEqual([...onDisk], [...bytes]);
	// Sem encoding continua texto, com diff.
	const text = await api.write({ path: "anexos/a.txt", content: "oi\n" });
	assert.equal(text.added, 1);
});
