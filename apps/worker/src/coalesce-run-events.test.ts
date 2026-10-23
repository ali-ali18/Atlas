import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { createRunEventCoalescer, RUN_EVENT_COALESCE_MAX_BYTES, RUN_EVENT_COALESCE_WINDOW_MS } from "./coalesce-run-events.js";

const delta = (id: string, text: string) => ({ type: "assistant_delta", id, delta: text }) as ComputerUseEvent;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder() {
	const written: ComputerUseEvent[] = [];
	return { written, write: async (event: ComputerUseEvent) => void written.push(event) };
}

test("padrões do plano A2: janela de 150 ms e teto de 4 KB", () => {
	assert.equal(RUN_EVENT_COALESCE_WINDOW_MS, 150);
	assert.equal(RUN_EVENT_COALESCE_MAX_BYTES, 4096);
});

test("deltas do mesmo balão viram um evento só ao fim da janela", async () => {
	const { written, write } = recorder();
	const coalescer = createRunEventCoalescer(write, { windowMs: 20 });
	await coalescer.push(delta("a", "Olá"));
	await coalescer.push(delta("a", ", mundo"));
	assert.equal(written.length, 0);
	await sleep(40);
	await coalescer.flush();
	assert.deepEqual(written, [delta("a", "Olá, mundo")]);
});

test("passou do teto de bytes: grava na hora, sem esperar a janela", async () => {
	const { written, write } = recorder();
	const coalescer = createRunEventCoalescer(write, { windowMs: 60_000, maxBytes: 10 });
	await coalescer.push(delta("a", "12345"));
	assert.equal(written.length, 0);
	// "çã" ocupa 4 bytes em UTF-8: 5 + 1 + 4 = 10 bytes, no teto.
	await coalescer.push(delta("a", "6çã"));
	assert.deepEqual(written, [delta("a", "123456çã")]);
	// O lote seguinte começa do zero.
	await coalescer.push(delta("a", "x"));
	assert.equal(written.length, 1);
	await coalescer.flush();
	assert.deepEqual(written, [delta("a", "123456çã"), delta("a", "x")]);
});

test("evento que não é delta grava o lote antes dele (ordem preservada) e flush do fim do run esvazia", async () => {
	const { written, write } = recorder();
	const coalescer = createRunEventCoalescer(write, { windowMs: 60_000 });
	await coalescer.push(delta("a", "antes"));
	const tool = { type: "status", status: "running", detail: "tool" } as ComputerUseEvent;
	await coalescer.push(tool);
	await coalescer.push(delta("b", "depois"));
	await coalescer.push(delta("c", "outro balão"));
	assert.deepEqual(written, [delta("a", "antes"), tool, delta("b", "depois")]);
	await coalescer.flush();
	assert.deepEqual(written, [delta("a", "antes"), tool, delta("b", "depois"), delta("c", "outro balão")]);
});
