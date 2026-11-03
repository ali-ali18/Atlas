import { test } from "node:test";
import assert from "node:assert/strict";
import { runExclusive } from "./page-lock.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runExclusive: tarefas da mesma aba rodam em fila, sem sobrepor", async () => {
	const page = {};
	const log = [];
	const task = (name, ms) => runExclusive(page, async () => {
		log.push(`start ${name}`);
		await sleep(ms);
		log.push(`end ${name}`);
	});
	await Promise.all([task("snapshot", 40), task("click", 5)]);
	assert.deepEqual(log, ["start snapshot", "end snapshot", "start click", "end click"]);
});

test("runExclusive: abas diferentes não se bloqueiam e erro não trava a fila", async () => {
	const a = {};
	const b = {};
	const log = [];
	const slow = runExclusive(a, async () => { await sleep(40); log.push("a"); });
	await runExclusive(b, async () => log.push("b"));
	assert.deepEqual(log, ["b"]);
	await slow;
	await assert.rejects(runExclusive(a, async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await runExclusive(a, async () => "ok"), "ok");
});
