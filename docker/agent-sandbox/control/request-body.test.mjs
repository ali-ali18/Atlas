import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { HttpError, readJsonBody } from "./request-body.mjs";

const req = (text, headers = {}) => Object.assign(Readable.from([Buffer.from(text)]), { headers });

test("readJsonBody: corpo normal, vazio e JSON inválido (400)", async () => {
	assert.deepEqual(await readJsonBody(req('{"a":1}')), { a: 1 });
	assert.deepEqual(await readJsonBody(req("")), {});
	await assert.rejects(readJsonBody(req("{oops")), (e) => e instanceof HttpError && e.status === 400);
});

test("readJsonBody: acima do teto vira 413, por content-length ou pelo tamanho lido", async () => {
	await assert.rejects(readJsonBody(req("{}", { "content-length": "999999999" }), 100), (e) => e.status === 413);
	await assert.rejects(readJsonBody(req(JSON.stringify({ x: "a".repeat(500) })), 100), (e) => e.status === 413);
});
