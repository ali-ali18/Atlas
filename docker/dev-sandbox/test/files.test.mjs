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

async function patchCase(content, old, neu, extra = {}) {
	const { dir, api } = await setup();
	const file = path.posix.join(dir, "f.txt");
	await fsp.writeFile(file, content);
	const run = () => api.patch({ path: "f.txt", old, new: neu, ...extra });
	return { api, file, run, read: () => fsp.readFile(file, "utf8") };
}

test("patch: old com LF casa em arquivo CRLF e preserva CRLF", async () => {
	const c = await patchCase("a\r\nb\r\nc\r\n", "a\nb", "a\nB");
	const r = await c.run();
	assert.equal(await c.read(), "a\r\nB\r\nc\r\n");
	assert.match(r.note, /CRLF/);
});

test("patch: ignora espaço em branco no fim das linhas", async () => {
	const c = await patchCase("foo()  \nbar()\t\nbaz\n", "foo()\nbar()", "foo()\nqux()");
	const r = await c.run();
	assert.equal(await c.read(), "foo()\nqux()\nbaz\n");
	assert.match(r.note, /espaços no fim/);
});

test("patch: tolera indentação diferente e reindenta new", async () => {
	const c = await patchCase("function f() {\n    if (x) {\n        go();\n    }\n}\n", "if (x) {\n    go();\n}", "if (x) {\n    go();\n    stop();\n}");
	const r = await c.run();
	assert.equal(await c.read(), "function f() {\n    if (x) {\n        go();\n        stop();\n    }\n}\n");
	assert.match(r.note, /indentação/);
});

test("patch: correspondência aproximada ambígua lista linhas e é rejeitada", async () => {
	const c = await patchCase("  a\nx\n    a\n", "a", "b", {});
	// exato casa 2 vezes ("a" em duas linhas): lista as linhas
	await assert.rejects(c.run, (e) => e instanceof FileError && /2 vezes/.test(e.message) && /linhas? 1/.test(e.message) && /3/.test(e.message));
	const d = await patchCase("  a;\n  x\n    a;\n", "a;\nx", "b");
	const r = await d.run(); // só uma janela de 2 linhas casa
	assert.equal(await d.read(), "  b\n    a;\n");
	assert.ok(r.note);
	const e2 = await patchCase("  a;\n  b;\nx\n    a;\n      b;\n", "a;\nb;", "c;");
	await assert.rejects(e2.run, (e) => /2 vezes/.test(e.message) && /1/.test(e.message) && /4/.test(e.message));
});

test("patch: replaceAll só vale com correspondência exata", async () => {
	const c = await patchCase("  a;\n    a;\n", "a;\na;", "b;", { replaceAll: true });
	await assert.rejects(c.run, (e) => /replace_all/.test(e.message));
});

test("patch: edição já aplicada é explicada", async () => {
	const c = await patchCase("const x = 2;\n", "const x = 1;", "const x = 2;");
	await assert.rejects(c.run, (e) => e instanceof FileError && /já (foi )?aplicad/.test(e.message));
});

test("patch: sem casamento, o erro mostra trechos parecidos com linhas e contexto", async () => {
	const body = Array.from({ length: 30 }, (_, i) => `const filler${i} = ${i};`);
	body[19] = "export function computeTotal(items, taxRate) {";
	body[20] = "  return items.reduce((s, i) => s + i.price, 0) * (1 + taxRate);";
	const c = await patchCase(`${body.join("\n")}\n`, "export function computeTotals(items, tax) {\n  return items.reduce((a, b) => a + b.price, 0);", "x");
	await assert.rejects(c.run, (e) => {
		assert.ok(e instanceof FileError);
		assert.match(e.message, /Trechos parecidos:/);
		assert.match(e.message, /20\b/);
		assert.match(e.message, /computeTotal\(items, taxRate\)/);
		assert.match(e.message, /filler17/); // 2 linhas de contexto antes
		assert.ok(e.message.length <= 1700);
		return true;
	});
});

test("patch: sem nada parecido, o erro não inventa trechos", async () => {
	const c = await patchCase("alpha\nbeta\n", "zzzzzzzz qqqqqq wwwww", "y");
	await assert.rejects(c.run, (e) => !/Trechos parecidos/.test(e.message) && /não foi encontrado/.test(e.message));
});

test("patch e write devolvem a janela editada (±3 linhas, no máximo 40)", async () => {
	const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
	const c = await patchCase(`${lines.join("\n")}\n`, "l10", "L10");
	const r = await c.run();
	assert.deepEqual(r.excerpt, { firstLine: 7, text: "l7\nl8\nl9\nL10\nl11\nl12\nl13" });
	const { api } = await setup();
	const big = Array.from({ length: 100 }, (_, i) => `n${i + 1}`).join("\n");
	const w = await api.write({ path: "big.txt", content: big });
	assert.equal(w.excerpt.firstLine, 1);
	assert.equal(w.excerpt.text.split("\n").length, 40);
	const w2 = await api.write({ path: "big.txt", content: big.replace("n50", "N50") });
	assert.deepEqual(w2.excerpt, { firstLine: 47, text: "n47\nn48\nn49\nN50\nn51\nn52\nn53" });
	const bin = await api.write({ path: "b.bin", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" });
	assert.equal(bin.excerpt, undefined);
});

test("sintaxe: .json e .js quebrados pela edição são reportados, sem bloquear a gravação", async () => {
	const { dir, api } = await setup();
	const w = await api.write({ path: "c.json", content: '{"a": 1,}' });
	assert.match(w.syntaxError, /JSON/i);
	assert.equal(await fsp.readFile(path.posix.join(dir, "c.json"), "utf8"), '{"a": 1,}');
	await api.write({ path: "ok.mjs", content: "export const a = 1;\n" });
	const p = await api.patch({ path: "ok.mjs", old: "= 1;", new: "= ;" });
	assert.match(p.syntaxError, /linha 1.*SyntaxError/s);
	const ok = await api.write({ path: "fine.cjs", content: "module.exports = 1;\n" });
	assert.equal(ok.syntaxError, undefined);
});

test("sintaxe: só erro novo conta (arquivo já quebrado antes não repete) e .ts é ignorado", async () => {
	const { dir, api } = await setup();
	await fsp.writeFile(path.posix.join(dir, "bad.json"), '{"a": }');
	const p = await api.patch({ path: "bad.json", old: '"a"', new: '"b"' });
	assert.equal(p.syntaxError, undefined);
	const fixed = await api.write({ path: "bad.json", content: '{"b": 1}' });
	assert.equal(fixed.syntaxError, undefined);
	const ts = await api.write({ path: "x.ts", content: "const = ;" });
	assert.equal(ts.syntaxError, undefined);
	await fsp.writeFile(path.posix.join(dir, "old.js"), "let = ;\n");
	const j = await api.patch({ path: "old.js", old: "let = ;", new: "const x = 1 2;" });
	assert.match(j.syntaxError ?? "", /SyntaxError/); // erro diferente do anterior: é novo
	assert.deepEqual((await fsp.readdir(dir)).filter((n) => n.includes("atlas-before")), []);
});
