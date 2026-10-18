import test from "node:test";
import assert from "node:assert/strict";
import { capTail, createOutputBuffer } from "../server/output-buffer.mjs";

test("offsets lógicos e leitura incremental", () => {
	const b = createOutputBuffer();
	b.append("abc");
	const first = b.read(0);
	assert.equal(first.text, "abc");
	b.append("def");
	const next = b.read(first.nextOffset);
	assert.equal(next.text, "def");
	assert.equal(next.truncated, false);
});

test("descarta o começo acima do teto e avisa", () => {
	const b = createOutputBuffer({ maxBytes: 10 });
	for (let i = 0; i < 5; i += 1) b.append("0123456789");
	assert.ok(b.dropped > 0);
	const r = b.read(0);
	assert.equal(r.truncated, true);
	assert.ok(r.omittedBytes >= b.dropped);
});

test("cap devolve o fim da saída", () => {
	const b = createOutputBuffer();
	b.append("x".repeat(100) + "FIM");
	const r = b.read(0, 10);
	assert.ok(r.text.endsWith("FIM"));
	assert.equal(r.truncated, true);
});

test("capTail corta mantendo o final com nota", () => {
	const r = capTail("a".repeat(50) + "z", 5);
	assert.equal(r.truncated, true);
	assert.ok(r.text.endsWith("aaaaz"));
	assert.match(r.text, /omitidos/);
});
