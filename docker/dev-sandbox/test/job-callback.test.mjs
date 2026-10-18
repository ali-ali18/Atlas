import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createJobCallback, signCallback } from "../server/job-callback.mjs";
import { createExecManager } from "../server/exec-jobs.mjs";

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const skip = (process.platform !== "win32" || process.env.DEV_TEST_FORCE_EXEC) && hasBash ? false : "requer bash/POSIX";
const tick = () => new Promise((r) => setTimeout(r, 20));

function make(responses) {
	const calls = [];
	const sleeps = [];
	const fetch = async (url, init) => {
		calls.push({ url, init });
		const next = responses[Math.min(calls.length - 1, responses.length - 1)];
		if (next instanceof Error) throw next;
		return { ok: next < 300, status: next };
	};
	const notify = createJobCallback({ url: "http://api/cb", token: "tok", sessionId: "s1", fetch, sleep: async (ms) => void sleeps.push(ms), now: () => 1_700_000_000_000 });
	return { notify, calls, sleeps };
}

const event = { jobId: "abc", status: "exited", exitCode: 0, durationMs: 5, endedAt: 1 };

test("assinatura HMAC conhecida (vetor compartilhado com a API)", () => {
	assert.equal(signCallback("tok", "s1", "1700000000", "{}"), signCallback("tok", "s1", "1700000000", "{}"));
	assert.notEqual(signCallback("tok", "s1", "1700000000", "{}"), signCallback("tok", "s2", "1700000000", "{}"));
});

test("envia JSON assinado, sem saída e sem o token", async () => {
	const { notify, calls } = make([200]);
	notify(event);
	await tick();
	assert.equal(calls.length, 1);
	const { init } = calls[0];
	const body = JSON.parse(init.body);
	assert.deepEqual(Object.keys(body).sort(), ["durationMs", "endedAt", "exitCode", "jobId", "sessionId", "status"]);
	assert.equal(init.headers["X-Atlas-Signature"], `sha256=${signCallback("tok", "s1", "1700000000", init.body)}`);
	assert.ok(!init.body.includes("tok"));
});

test("repete até 3 vezes com espera crescente e desiste", async () => {
	const { notify, calls, sleeps } = make([500, new Error("down"), 503, 502]);
	notify(event);
	await tick();
	assert.equal(calls.length, 4);
	assert.deepEqual(sleeps, [500, 1500, 4000]);
});

test("para ao primeiro sucesso e não repete 4xx", async () => {
	const a = make([502, 200]);
	a.notify(event);
	await tick();
	assert.equal(a.calls.length, 2);
	const b = make([401]);
	b.notify(event);
	await tick();
	assert.equal(b.calls.length, 1);
});

test("sem URL/token/sessão não há notificador", () => {
	assert.equal(createJobCallback({ url: "", token: "t", sessionId: "s" }), null);
});

test("job em segundo plano dispara onEnd; primeiro plano não", { skip }, async () => {
	const ends = [];
	const dir = os.tmpdir();
	const m = createExecManager({ workspace: dir, home: dir, confine: async (p) => (typeof p === "string" ? p : dir), onEnd: (e) => ends.push(e) });
	await m.run({ cmd: "true" });
	assert.equal(ends.length, 0);
	const job = await m.start({ cmd: "exit 4" }, { background: true });
	for (let i = 0; i < 100 && !ends.length; i += 1) await new Promise((r) => setTimeout(r, 100));
	assert.equal(ends.length, 1);
	assert.equal(ends[0].jobId, job.id);
	assert.equal(ends[0].exitCode, 4);
	assert.equal(ends[0].status, "exited");
});
