import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createAuthGate, isAuthorized, takeControlToken } from "./control-auth.mjs";

const TOKEN = "a".repeat(43);

async function withServer(token, fn, warn = () => {}) {
	const gate = createAuthGate(token, warn);
	const server = http.createServer((req, res) => {
		if (!gate(req, res)) return;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await fn(`http://127.0.0.1:${server.address().port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test("com token: recusa sem cabeçalho, com token errado e com tamanho diferente", async () => {
	await withServer(TOKEN, async (base) => {
		const wrong = [
			{},
			{ Authorization: `Bearer ${"b".repeat(43)}` },
			{ Authorization: "Bearer curto" },
			{ Authorization: `Bearer ${TOKEN}extra` },
			{ Authorization: TOKEN },
			{ Authorization: `Basic ${TOKEN}` },
		];
		for (const headers of wrong) {
			const response = await fetch(`${base}/card-fill`, { method: "POST", headers });
			assert.equal(response.status, 401);
			const text = await response.text();
			assert.equal(text, JSON.stringify({ error: "unauthorized" }));
		}
	});
});

test("com token: aceita o token certo em qualquer rota, health incluso", async () => {
	await withServer(TOKEN, async (base) => {
		for (const path of ["/health", "/browser/v4", "/idle"]) {
			const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
			assert.equal(response.status, 200);
		}
		assert.equal((await fetch(`${base}/health`)).status, 401);
	});
});

test("sem token (imagem antiga): mantém o comportamento aberto e avisa uma vez na subida", async () => {
	const warnings = [];
	await withServer(
		null,
		async (base) => {
			assert.equal((await fetch(`${base}/health`)).status, 200);
			assert.equal((await fetch(`${base}/idle`)).status, 200);
		},
		(message) => warnings.push(message),
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /SANDBOX_CONTROL_TOKEN/);
});

test("isAuthorized: cabeçalho ausente ou malformado nunca passa", () => {
	assert.equal(isAuthorized(TOKEN, undefined), false);
	assert.equal(isAuthorized(TOKEN, ""), false);
	assert.equal(isAuthorized(TOKEN, "Bearer"), false);
	assert.equal(isAuthorized(TOKEN, `Bearer ${TOKEN}`), true);
});

test("takeControlToken apaga a variável e o filho não a herda", () => {
	const env = { ...process.env, SANDBOX_CONTROL_TOKEN: TOKEN };
	assert.equal(takeControlToken(env), TOKEN);
	assert.equal("SANDBOX_CONTROL_TOKEN" in env, false);
	const out = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.env.SANDBOX_CONTROL_TOKEN))"], { env, encoding: "utf8" });
	assert.equal(out, "undefined");
	assert.equal(takeControlToken({}), null);
	assert.equal(takeControlToken({ SANDBOX_CONTROL_TOKEN: "" }), null);
});
