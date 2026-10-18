import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { createSiwcLoopback } = await import("./siwc-loopback.js");

/** Porta livre acima de 1024 (a validação do listener recusa portas baixas). */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

async function reachable(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/x`, { signal: AbortSignal.timeout(500) });
		return true;
	} catch {
		return false;
	}
}

const ok = async () => new Response(null, { status: 404 });

test("listener é lazy: só abre no ensure e fecha com stop; religa no próximo ensure", async () => {
	const port = await freePort();
	const loopback = createSiwcLoopback({
		env: { ATLAS_SIWC_CALLBACK_PORT: String(port) } as NodeJS.ProcessEnv,
		handler: ok,
	});
	assert.equal(loopback.isListening(), false);
	assert.equal(await reachable(port), false, "nada escuta antes do Conectar");

	await loopback.ensure();
	assert.equal(loopback.isListening(), true);
	assert.equal(await reachable(port), true);

	await loopback.stop();
	assert.equal(loopback.isListening(), false);
	assert.equal(await reachable(port), false, "desligar o plano fecha a porta");

	await loopback.ensure();
	assert.equal(await reachable(port), true);
	await loopback.stop();
});

test("stop sem listener é inofensivo", async () => {
	const loopback = createSiwcLoopback({ handler: ok });
	await loopback.stop();
	assert.equal(loopback.isListening(), false);
});

test("fecha sozinho depois de um callback concluído (redirect)", async () => {
	const port = await freePort();
	const loopback = createSiwcLoopback({
		env: { ATLAS_SIWC_CALLBACK_PORT: String(port) } as NodeJS.ProcessEnv,
		handler: async () => new Response(null, { status: 302, headers: { Location: "http://localhost:3000/" } }),
	});
	await loopback.ensure();
	const res = await fetch(`http://127.0.0.1:${port}/callback`, { redirect: "manual" });
	assert.equal(res.status, 302);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(loopback.isListening(), false);
	assert.equal(await reachable(port), false);
});

test("fecha sozinho quando fica ocioso", async () => {
	const port = await freePort();
	const loopback = createSiwcLoopback({
		env: { ATLAS_SIWC_CALLBACK_PORT: String(port) } as NodeJS.ProcessEnv,
		handler: ok,
		idleMs: 50,
	});
	await loopback.ensure();
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(loopback.isListening(), false);
});

test("porta inválida recusa subir", async () => {
	const loopback = createSiwcLoopback({
		env: { ATLAS_SIWC_CALLBACK_PORT: "80" } as NodeJS.ProcessEnv,
		handler: ok,
	});
	await assert.rejects(loopback.ensure());
	assert.equal(loopback.isListening(), false);
});
