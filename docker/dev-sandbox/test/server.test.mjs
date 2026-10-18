import test from "node:test";
import assert from "node:assert/strict";
import { createDevServer, isAuthorized } from "../server.mjs";
import { buildRgArgs, GrepError } from "../server/grep.mjs";

test("isAuthorized exige bearer exato", () => {
	assert.equal(isAuthorized("Bearer abc", "abc"), true);
	assert.equal(isAuthorized("Bearer abd", "abc"), false);
	assert.equal(isAuthorized("Bearer abcd", "abc"), false);
	assert.equal(isAuthorized(undefined, "abc"), false);
	assert.equal(isAuthorized("Bearer abc", ""), false);
});

test("rotas exigem token; /health é aberto", async () => {
	const fake = Object.assign(async () => false, { exec: { list: () => [] } });
	const server = createDevServer({ token: "tok", coding: fake });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		assert.equal((await fetch(`${base}/health`)).status, 200);
		assert.equal((await fetch(`${base}/exec/aaaaaaaaaaaa`)).status, 401);
		assert.equal((await fetch(`${base}/exec/aaaaaaaaaaaa`, { headers: { Authorization: "Bearer errado" } })).status, 401);
		assert.equal((await fetch(`${base}/exec/aaaaaaaaaaaa`, { headers: { Authorization: "Bearer tok" } })).status, 404);
	} finally {
		server.close();
	}
});

test("buildRgArgs valida e monta argv sem shell", () => {
	assert.throws(() => buildRgArgs({ pattern: "" }), GrepError);
	const { args, maxResults } = buildRgArgs({ pattern: "a b; rm -rf /", glob: "*.ts", maxResults: 9999 });
	assert.ok(args.includes("a b; rm -rf /"));
	assert.ok(args.includes("*.ts"));
	assert.equal(maxResults, 200);
});
