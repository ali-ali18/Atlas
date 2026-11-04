import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUploadPath } from "./upload-path.mjs";

async function workspace() {
	const dir = await mkdtemp(join(tmpdir(), "atlas-upload-"));
	const root = join(dir, "work");
	await mkdir(join(root, "sub"), { recursive: true });
	await mkdir(join(root, ".cache"), { recursive: true });
	await writeFile(join(root, "a.txt"), "hello");
	await writeFile(join(root, "sub", "b.txt"), "b");
	await writeFile(join(root, ".cache", "secret.txt"), "s");
	await writeFile(join(dir, "outside.txt"), "x");
	await symlink(join(dir, "outside.txt"), join(root, "link.txt"));
	return root;
}

test("upload: aceita arquivo da pasta de trabalho (relativo ou absoluto)", async () => {
	const root = await workspace();
	assert.match(await resolveUploadPath("a.txt", { root }), /a\.txt$/);
	assert.match(await resolveUploadPath("sub/b.txt", { root }), /b\.txt$/);
	assert.match(await resolveUploadPath(join(root, "a.txt"), { root }), /a\.txt$/);
});

test("upload: recusa fora da pasta, '..', link que sai, oculto, pasta e vazio", async () => {
	const root = await workspace();
	await assert.rejects(resolveUploadPath("../outside.txt", { root }), /Só arquivos/);
	await assert.rejects(resolveUploadPath("/etc/passwd", { root }), /Só arquivos|não encontrado/);
	await assert.rejects(resolveUploadPath("link.txt", { root }), /Só arquivos/);
	await assert.rejects(resolveUploadPath(".cache/secret.txt", { root }), /ocultos/);
	await assert.rejects(resolveUploadPath("sub", { root }), /não é um arquivo/);
	await assert.rejects(resolveUploadPath("nao-existe.txt", { root }), /não encontrado/);
	await assert.rejects(resolveUploadPath("  ", { root }), /exige/);
	await assert.rejects(resolveUploadPath("a\0b", { root }), /exige/);
});

test("upload: arquivo grande demais é recusado", async () => {
	const root = await workspace();
	const fs = { realpath: (await import("node:fs/promises")).realpath, stat: async () => ({ isFile: () => true, size: 26 * 1024 * 1024 }) };
	await assert.rejects(resolveUploadPath("a.txt", { root, fs }), /grande demais/);
});
