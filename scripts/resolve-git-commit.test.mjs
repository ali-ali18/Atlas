import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveGitCommit } from "./resolve-git-commit.mjs";

const A = "a".repeat(40);
const B = "0123456789abcdef0123456789abcdef01234567";

function fakeGit(files) {
	const dir = mkdtempSync(join(tmpdir(), "fakegit-"));
	for (const [name, content] of Object.entries(files)) {
		const file = join(dir, name);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, content);
	}
	return dir;
}

test("HEAD apontando para ref solta", () => {
	assert.equal(resolveGitCommit(fakeGit({ HEAD: "ref: refs/heads/main\n", "refs/heads/main": `${A}\n` })), A);
});
test("HEAD destacado (hash direto)", () => {
	assert.equal(resolveGitCommit(fakeGit({ HEAD: `${B}\n` })), B);
});
test("ref só em packed-refs", () => {
	const git = fakeGit({ HEAD: "ref: refs/heads/main\r\n", "packed-refs": `# pack-refs\n${A} refs/heads/outra\n${B} refs/heads/main\n^${A}\n` });
	assert.equal(resolveGitCommit(git), B);
});
test("sem .git, HEAD lixo ou ref ausente devolvem vazio", () => {
	assert.equal(resolveGitCommit(join(tmpdir(), "nao-existe-xyz")), "");
	assert.equal(resolveGitCommit(fakeGit({ HEAD: "lixo\n" })), "");
	assert.equal(resolveGitCommit(fakeGit({ HEAD: "ref: refs/heads/main\n" })), "");
});
