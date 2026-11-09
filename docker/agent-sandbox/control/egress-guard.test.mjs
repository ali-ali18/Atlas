// Guarda de egress do Chromium: IPs, nomes, DNS por salto e a rota do Playwright. Sem rede: o DNS é um fake.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEgressGuard, installEgressGuard, isBlockedHostname, isBlockedIp } from "./egress-guard.mjs";

test("IPv4 interno é bloqueado; público passa", () => {
	for (const ip of ["169.254.169.254", "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.17.0.2", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) {
		assert.equal(isBlockedIp(ip), true, ip);
	}
	for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "93.184.216.34", "100.63.255.255"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("IPv6 que não é unicast global é bloqueado; v4 embutido vale o v4", () => {
	for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2001:db8::1", "2002:a9fe:a9fe::1", "[::1]", "nao-e-ip"]) {
		assert.equal(isBlockedIp(ip), true, ip);
	}
	for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("nomes internos são bloqueados", () => {
	for (const host of ["localhost", "app.localhost", "metadata.google.internal", "host.docker.internal", "redis", "docker-socket-proxy", "impressora.local", "x.internal", ""]) {
		assert.equal(isBlockedHostname(host), true, host);
	}
	for (const host of ["example.com", "loja.com.br", "pay.stripe.com", "1.1.1.1"]) assert.equal(isBlockedHostname(host), false, host);
});

test("check: formas disfarçadas de IP e esquemas", async () => {
	const guard = createEgressGuard({ lookup: async () => [{ address: "93.184.216.34" }] });
	// O parser de URL normaliza decimal/hex/octal para 127.0.0.1.
	for (const url of ["http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/latest/meta-data/", "http://user:pw@example.com/", "ftp://localhost/x", "javascript:alert(1)", "gopher://example.com"]) {
		assert.equal((await guard.check(url)).ok, false, url);
	}
	for (const url of ["https://example.com/a?b=1", "about:blank", "data:text/plain,oi", "blob:https://example.com/uuid"]) assert.equal((await guard.check(url)).ok, true, url);
	assert.equal((await guard.check("nao é url")).ok, false);
});

test("DNS é resolvido por salto: nome público que aponta para rede interna é bloqueado, qualquer endereço ruim barra", async () => {
	let answer = [{ address: "93.184.216.34" }];
	let calls = 0;
	let clock = 0;
	const guard = createEgressGuard({ lookup: async () => (calls++, answer), now: () => clock, ttlMs: 1000 });
	assert.equal((await guard.check("https://loja.exemplo/")).ok, true);
	assert.equal((await guard.check("https://loja.exemplo/img.png")).ok, true);
	assert.equal(calls, 1, "o cache curto evita resolver a cada subrecurso");
	clock = 5000;
	answer = [{ address: "93.184.216.34" }, { address: "10.0.0.7" }];
	const verdict = await guard.check("https://loja.exemplo/redirect");
	assert.equal(verdict.ok, false);
	assert.equal(calls, 2);
	answer = [{ address: "169.254.169.254" }];
	clock = 9000;
	assert.equal((await guard.check("https://rebind.exemplo/")).ok, false);
	// motivo não repete a URL (pode levar token na query)
	assert.doesNotMatch((await guard.check("https://rebind.exemplo/?token=segredo")).reason, /segredo|rebind/);
});

test("DNS que falha ou volta vazio bloqueia (fail-closed)", async () => {
	assert.equal((await createEgressGuard({ lookup: async () => { throw new Error("ENOTFOUND"); } }).check("https://x.exemplo/")).ok, false);
	assert.equal((await createEgressGuard({ lookup: async () => [] }).check("https://x.exemplo/")).ok, false);
});

test("installEgressGuard aborta o bloqueado, deixa passar o público e falha fechado", async () => {
	let handler;
	const context = { route: async (_pattern, fn) => { handler = fn; } };
	const blocked = [];
	await installEgressGuard(context, createEgressGuard({ lookup: async () => [{ address: "93.184.216.34" }] }), (reason) => blocked.push(reason));
	const run = async (url) => {
		const out = {};
		await handler({ request: () => ({ url: () => url }), fallback: () => { out.passed = true; }, abort: (code) => { out.aborted = code; } });
		return out;
	};
	assert.deepEqual(await run("https://example.com/"), { passed: true });
	assert.deepEqual(await run("http://169.254.169.254/latest/"), { aborted: "blockedbyclient" });
	assert.deepEqual(blocked, ["private or reserved address"]);
	await installEgressGuard(context, { check: async () => { throw new Error("boom"); } });
	assert.deepEqual(await run("https://example.com/"), { aborted: "blockedbyclient" });
});
