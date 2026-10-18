import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { createEgressPolicy, createEgressProxy, hostAllowed, normalizeAllowlist, normalizePattern } from "../server/egress-proxy.mjs";

test("normalizePattern limpa esquema, porta e caminho e recusa lixo", () => {
	assert.equal(normalizePattern(" HTTPS://Registry.NPMjs.org:443/pkg "), "registry.npmjs.org");
	assert.equal(normalizePattern("*.githubusercontent.com"), "*.githubusercontent.com");
	assert.equal(normalizePattern("localhost"), null);
	assert.equal(normalizePattern("a b.com"), null);
	assert.equal(normalizePattern("*.com"), null);
	assert.equal(normalizePattern("*"), null);
	assert.equal(normalizePattern(42), null);
	assert.deepEqual(normalizeAllowlist(["github.com", "GitHub.com", "x", ""]), ["github.com"]);
});

test("hostAllowed: exato, curinga só para subdomínios, IP nunca casa curinga", () => {
	const list = ["github.com", "*.githubusercontent.com"];
	assert.equal(hostAllowed("github.com", list), true);
	assert.equal(hostAllowed("GITHUB.com.", list), true);
	assert.equal(hostAllowed("api.github.com", list), false);
	assert.equal(hostAllowed("raw.githubusercontent.com", list), true);
	assert.equal(hostAllowed("a.b.githubusercontent.com", list), true);
	assert.equal(hostAllowed("githubusercontent.com", list), false);
	assert.equal(hostAllowed("evilgithubusercontent.com", list), false);
	assert.equal(hostAllowed("github.com.evil.io", list), false);
	assert.equal(hostAllowed("140.82.112.3", list), false);
	assert.equal(hostAllowed("", list), false);
});

test("política: full não usa proxy; off bloqueia tudo; allowlist limita portas", () => {
	const policy = createEgressPolicy({ mode: "full" });
	assert.deepEqual(policy.env(), {});
	assert.equal(policy.check("example.com", 443).ok, true);
	policy.set({ mode: "allowlist", allowlist: ["pypi.org"] });
	assert.equal(policy.env().HTTPS_PROXY, "http://127.0.0.1:3128");
	assert.equal(policy.check("pypi.org", 443).ok, true);
	assert.equal(policy.check("pypi.org", 22).ok, false);
	assert.equal(policy.check("example.com", 443).ok, false);
	policy.set({ mode: "off", allowlist: ["pypi.org"] });
	assert.equal(policy.check("pypi.org", 443).ok, false);
	assert.throws(() => policy.set({ mode: "x" }));
});

async function startEcho() {
	const server = net.createServer((socket) => socket.on("data", (d) => socket.write(`eco:${d}`)));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return server;
}

function connectVia(proxyPort, target) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
		req.on("connect", (res, socket) => resolve({ status: res.statusCode, socket }));
		req.on("error", reject);
		req.end();
	});
}

test("proxy: CONNECT liberado túnela, não liberado recebe 403", async () => {
	const echo = await startEcho();
	const policy = createEgressPolicy({ mode: "allowlist", allowlist: ["registry.npmjs.org", "*.github.com"] });
	const proxy = createEgressProxy(policy, { connect: (_port, _host, cb) => net.connect(echo.address().port, "127.0.0.1", cb) });
	const addr = await proxy.listen(0, "127.0.0.1");
	try {
		const ok = await connectVia(addr.port, "registry.npmjs.org:443");
		assert.equal(ok.status, 200);
		const reply = await new Promise((resolve) => {
			ok.socket.once("data", (d) => resolve(String(d)));
			ok.socket.write("oi");
		});
		assert.equal(reply, "eco:oi");
		ok.socket.destroy();

		const wildcard = await connectVia(addr.port, "codeload.github.com:443");
		assert.equal(wildcard.status, 200);
		wildcard.socket.destroy();

		const blocked = await connectVia(addr.port, "example.com:443");
		assert.equal(blocked.status, 403);
		blocked.socket.destroy();

		const badPort = await connectVia(addr.port, "registry.npmjs.org:22");
		assert.equal(badPort.status, 403);
		badPort.socket.destroy();

		policy.set({ mode: "off", allowlist: [] });
		const off = await connectVia(addr.port, "registry.npmjs.org:443");
		assert.equal(off.status, 403);
		off.socket.destroy();
	} finally {
		proxy.close();
		echo.close();
	}
});

test("proxy: HTTP simples fora da lista recebe 403 com motivo", async () => {
	const policy = createEgressPolicy({ mode: "allowlist", allowlist: ["pypi.org"] });
	const proxy = createEgressProxy(policy);
	const addr = await proxy.listen(0, "127.0.0.1");
	try {
		const status = await new Promise((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: addr.port, method: "GET", path: "http://example.com/x", headers: { host: "example.com" } }, (res) => {
				let body = "";
				res.on("data", (d) => (body += d));
				res.on("end", () => resolve({ code: res.statusCode, body }));
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(status.code, 403);
		assert.match(status.body, /fora da lista liberada/);
	} finally {
		proxy.close();
	}
});

test("proxy: cliente que derruba a conexão após o 403 não derruba o processo", async () => {
	const policy = createEgressPolicy({ mode: "allowlist", allowlist: ["pypi.org"] });
	const proxy = createEgressProxy(policy);
	const addr = await proxy.listen(0, "127.0.0.1");
	try {
		const socket = net.connect(addr.port, "127.0.0.1");
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
		socket.resetAndDestroy();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const ok = await connectVia(addr.port, "example.com:443");
		assert.equal(ok.status, 403);
		ok.socket.destroy();
	} finally {
		proxy.close();
	}
});
