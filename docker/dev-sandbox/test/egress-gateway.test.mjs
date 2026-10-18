import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createSessionPolicies, normalizeSourceIp, startGateway } from "../server/egress-gateway.mjs";
import { isPrivateAddress } from "../server/egress-proxy.mjs";

test("mapa de sessões: identifica pelo IP de origem e nega IP desconhecido", () => {
	const sessions = createSessionPolicies();
	assert.equal(normalizeSourceIp("::ffff:172.20.0.5"), "172.20.0.5");
	assert.equal(normalizeSourceIp("nao-ip"), null);
	assert.equal(sessions.check("github.com", 443, "172.20.0.5").ok, false);
	sessions.set("172.20.0.5", { mode: "allowlist", allowlist: ["github.com"], sessionId: "s1" });
	sessions.set("172.20.0.6", { mode: "off", allowlist: [] });
	assert.equal(sessions.check("github.com", 443, "::ffff:172.20.0.5").ok, true);
	assert.equal(sessions.check("example.com", 443, "172.20.0.5").ok, false);
	assert.equal(sessions.check("github.com", 22, "172.20.0.5").ok, false);
	assert.equal(sessions.check("github.com", 443, "172.20.0.6").ok, false);
	assert.equal(sessions.check("github.com", 443, "172.20.0.7").ok, false);
	// mudar a política de um IP vale na hora
	sessions.set("172.20.0.5", { mode: "off", allowlist: [] });
	assert.equal(sessions.check("github.com", 443, "172.20.0.5").ok, false);
	assert.equal(sessions.remove("172.20.0.5"), true);
	assert.equal(sessions.list().length, 1);
	assert.throws(() => sessions.set("x", { mode: "full" }));
	assert.throws(() => sessions.set("172.20.0.9", { mode: "tudo" }));
});

test("isPrivateAddress cobre loopback, redes privadas, metadata e IPv6 local", () => {
	for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
		assert.equal(isPrivateAddress(a), true, a);
	}
	for (const a of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700::1"]) assert.equal(isPrivateAddress(a), false, a);
});

async function listen(handler) {
	const server = net.createServer(handler);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server;
}

test("gateway: controle exige token; proxy nega origem sem política e aplica allowlist por origem", async () => {
	const token = "t".repeat(16);
	const gw = await startGateway({ token, proxyPort: 0, controlPort: 0, host: "127.0.0.1" });
	const proxyPort = gw.proxy.server.address().port;
	const controlPort = gw.control.address().port;
	const control = (method, path, body, auth = `Bearer ${token}`) =>
		fetch(`http://127.0.0.1:${controlPort}${path}`, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

	assert.equal((await control("GET", "/sessions", undefined, "Bearer errado")).status, 401);
	assert.equal((await fetch(`http://127.0.0.1:${controlPort}/health`)).status, 200);

	const connect = (host) =>
		new Promise((resolve) => {
			const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
			let data = "";
			s.on("data", (c) => (data += c));
			s.on("close", () => resolve(data));
			setTimeout(() => s.destroy(), 1500);
		});

	// origem 127.0.0.1 ainda não registrada
	assert.match(await connect("registry.npmjs.org"), /403/);
	assert.equal((await control("PUT", "/sessions/127.0.0.1", { mode: "allowlist", allowlist: ["registry.npmjs.org"], sessionId: "s1" })).status, 200);
	assert.match(await connect("example.com"), /403/);
	assert.equal((await control("DELETE", "/sessions/127.0.0.1")).status, 200);
	assert.match(await connect("registry.npmjs.org"), /403/);
	gw.proxy.close();
	gw.control.close();
});
