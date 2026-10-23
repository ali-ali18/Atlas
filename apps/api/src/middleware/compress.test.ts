import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { apiCompress, isCompressibleContentType } from "./compress.js";

function app() {
	const hono = new Hono();
	hono.use("*", apiCompress());
	hono.get("/json", (c) => c.json({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) }));
	hono.get("/sse", () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${"x".repeat(4096)}\n\n`));
				controller.close();
			},
		});
		// Igual às rotas de verdade: sem `no-transform`, para provar que o filtro de tipo basta.
		return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
	});
	return hono;
}

test("JSON grande sai comprimido quando o cliente aceita gzip", async () => {
	const response = await app().request("/json", { headers: { "Accept-Encoding": "gzip, deflate" } });
	assert.equal(response.headers.get("content-encoding"), "gzip");
	assert.match(response.headers.get("vary") ?? "", /accept-encoding/i);
	const body = await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).json();
	assert.equal(body.items.length, 200);
});

test("cliente sem gzip: sem compressão", async () => {
	assert.equal((await app().request("/json")).headers.get("content-encoding"), null);
});

test("SSE nunca é comprimido (o stream continua chegando em tempo real)", async () => {
	const response = await app().request("/sse", { headers: { "Accept-Encoding": "gzip, deflate, br" } });
	assert.equal(response.headers.get("content-encoding"), null);
	assert.match(await response.text(), /^data: x{4096}/);
	assert.equal(isCompressibleContentType("text/event-stream"), false);
	assert.equal(isCompressibleContentType("Text/Event-Stream; charset=utf-8"), false);
	assert.equal(isCompressibleContentType("application/json; charset=utf-8"), true);
	assert.equal(isCompressibleContentType("image/png"), false);
});
