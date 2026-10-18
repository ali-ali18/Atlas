import test from "node:test";
import assert from "node:assert/strict";
import { confinePath, PathError, resolveInput } from "../server/path-guard.mjs";

test("resolve relativo ao /workspace e normaliza ..", async () => {
	assert.equal(await confinePath("a/b/../c.txt"), "/workspace/a/c.txt");
	assert.equal(await confinePath("/tmp/x"), "/tmp/x");
});

test("bloqueia escape por .. e caminhos fora das raízes", async () => {
	await assert.rejects(() => confinePath("../etc/passwd"), PathError);
	await assert.rejects(() => confinePath("/etc/passwd"), PathError);
	await assert.rejects(() => confinePath("/workspace/../root"), PathError);
	await assert.rejects(() => confinePath("/workspacex/file"), PathError);
});

test("rejeita vazio e byte nulo", () => {
	assert.throws(() => resolveInput("  "), PathError);
	assert.throws(() => resolveInput("a\u0000b"), PathError);
});

test("symlink que aponta para fora é barrado via realpath", async () => {
	const realpath = async (p) => (p.startsWith("/workspace/link") ? p.replace("/workspace/link", "/etc") : p);
	await assert.rejects(() => confinePath("link/passwd", { realpath }), PathError);
	assert.equal(await confinePath("ok/file", { realpath }), "/workspace/ok/file");
});
