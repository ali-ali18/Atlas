import assert from "node:assert/strict";
import test from "node:test";
import { createSendQueue } from "./send-queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("duas mensagens enviadas enquanto o run é criado saem na ordem digitada, uma de cada vez", async () => {
	const queue = createSendQueue<string>();
	queue.push("segunda");
	queue.push("terceira");
	const log: string[] = [];
	let running = 0;
	let maxRunning = 0;
	await queue.flush(async (text) => {
		running += 1;
		maxRunning = Math.max(maxRunning, running);
		log.push(`início ${text}`);
		await tick();
		log.push(`fim ${text}`);
		running -= 1;
	});
	assert.deepEqual(log, ["início segunda", "fim segunda", "início terceira", "fim terceira"]);
	assert.equal(maxRunning, 1);
	assert.equal(queue.size, 0);
});

test("falha de um envio não perde os seguintes", async () => {
	const queue = createSendQueue<string>();
	queue.push("a");
	queue.push("b");
	const sent: string[] = [];
	await queue.flush(async (text) => {
		if (text === "a") throw new Error("rede");
		sent.push(text);
	});
	assert.deepEqual(sent, ["b"]);
});

test("trocar de conversa descarta a fila (a fala era da conversa anterior)", async () => {
	const queue = createSendQueue<string>();
	queue.push("da conversa antiga");
	queue.clear();
	const sent: string[] = [];
	await queue.flush(async (text) => void sent.push(text));
	assert.deepEqual(sent, []);
});

test("flushes seguidos encadeiam: o segundo lote só começa depois do primeiro terminar", async () => {
	const queue = createSendQueue<string>();
	const log: string[] = [];
	const send = async (text: string) => {
		log.push(`início ${text}`);
		await tick();
		log.push(`fim ${text}`);
	};
	queue.push("1");
	const first = queue.flush(send);
	queue.push("2");
	const second = queue.flush(send);
	await Promise.all([first, second]);
	assert.deepEqual(log, ["início 1", "fim 1", "início 2", "fim 2"]);
});
