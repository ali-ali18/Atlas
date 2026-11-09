// Proxy de saída local: valida o IP JÁ resolvido e conecta nele (sem segunda resolução). DNS falso e destinos locais; o teste
// com Chromium real (ws:// para IP privado, Worker, rebinding) se pula sem Chromium.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { test, after } from "node:test";
import { createGuardedProxy, resolveAllowed } from "./egress-proxy.mjs";
import { launchFixtureBrowser } from "./test-browser.mjs";

const PUBLIC = "203.0.113.9"; // TEST-NET-3: público para o guarda, nunca roteado
const rec = (address) => ({ address, family: address.includes(":") ? 6 : 4 });

/** Servidor HTTP local que faz o papel do "site público" (o proxy é levado a conectar nele em vez do IP de teste). */
async function origin(handler) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startProxy({ lookup, origins }) {
	const connected = [];
	const blocked = [];
	const proxy = createGuardedProxy({
		lookup,
		onBlock: (reason, host) => blocked.push([reason, host]),
		// Em vez de sair para a internet, redireciona para o "site" local, MAS registra o IP que o proxy validou e escolheu.
		connect: ({ host, port }) => (connected.push([host, port]), netConnect(origins[port] ?? origins.default, "127.0.0.1")),
	});
	const port = await proxy.listen(0);
	return { port, connected, blocked, close: proxy.close };
}

const rawConnect = (proxyPort, target) =>
	new Promise((resolve) => {
		const socket = netConnect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk;
			if (data.includes("\r\n\r\n")) {
				resolve({ head: data.split("\r\n")[0], socket });
			}
		});
		socket.on("close", () => resolve({ head: data.split("\r\n")[0], socket }));
	});

test("resolveAllowed: IP público passa; qualquer registro interno recusa; nome interno e porta de e-mail recusam", async () => {
	assert.equal((await resolveAllowed(PUBLIC, 443)).ok, true);
	assert.equal((await resolveAllowed("10.0.0.5", 80)).ok, false);
	assert.equal((await resolveAllowed("169.254.169.254", 80)).ok, false);
	assert.equal((await resolveAllowed("[::1]", 80)).ok, false);
	assert.equal((await resolveAllowed("localhost", 80)).ok, false);
	assert.equal((await resolveAllowed("db", 5432)).ok, false);
	assert.equal((await resolveAllowed("loja.example", 25, async () => [rec(PUBLIC)])).ok, false);
	assert.equal((await resolveAllowed("loja.example", 443, async () => [rec(PUBLIC), rec("10.1.1.1")])).ok, false, "um registro interno basta");
	assert.equal((await resolveAllowed("loja.example", 443, async () => { throw new Error("ENOTFOUND"); })).ok, false);
	const ok = await resolveAllowed("loja.example", 443, async () => [rec("2001:4860:4860::8888"), rec(PUBLIC)]);
	assert.equal(ok.address, PUBLIC, "prefere IPv4");
});

test("rebinding: o nome responde público à validação e privado depois; o proxy resolve UMA vez e conecta no IP validado", async () => {
	const site = await origin((_req, res) => res.end("ok"));
	let lookups = 0;
	const lookup = async () => (++lookups === 1 ? [rec(PUBLIC)] : [rec("127.0.0.1")]);
	const proxy = await startProxy({ lookup, origins: { default: site.port } });
	const { head, socket } = await rawConnect(proxy.port, "rebind.example:443");
	assert.match(head, /200/);
	socket.destroy();
	assert.equal(lookups, 1, "sem segunda resolução");
	assert.deepEqual(proxy.connected, [[PUBLIC, 443]], "a conexão foi para o IP checado");
	await proxy.close();
	await site.close();
});

test("rebinding ao contrário: nome que já aponta para rede interna é recusado e nada conecta", async () => {
	const proxy = await startProxy({ lookup: async () => [rec("127.0.0.1")], origins: { default: 1 } });
	const { head } = await rawConnect(proxy.port, "evil.example:443");
	assert.match(head, /403/);
	assert.deepEqual(proxy.connected, []);
	assert.equal(proxy.blocked[0][1], "evil.example");
	await proxy.close();
});

test("WebSocket (CONNECT ws:// para IP privado, metadata e loopback) e porta de e-mail são recusados", async () => {
	const proxy = await startProxy({ lookup: async () => [rec(PUBLIC)], origins: { default: 1 } });
	for (const target of ["10.0.0.5:8080", "169.254.169.254:80", "127.0.0.1:9222", "[::1]:80", "172.17.0.1:2375", "loja.example:25"]) {
		const { head } = await rawConnect(proxy.port, target);
		assert.match(head, /403/, target);
	}
	assert.deepEqual(proxy.connected, []);
	await proxy.close();
});

test("http:// absoluto: encaminha ao IP validado com o Host original; para IP interno responde 403", async () => {
	const seen = [];
	const site = await origin((req, res) => (seen.push([req.headers.host, req.url]), res.end("pagina")));
	const proxy = await startProxy({ lookup: async () => [rec(PUBLIC)], origins: { default: site.port } });
	const ok = await fetchViaProxy(proxy.port, "http://loja.example/x?y=1");
	assert.equal(ok.status, 200);
	assert.equal(ok.body, "pagina");
	assert.deepEqual(seen, [["loja.example", "/x?y=1"]]);
	assert.deepEqual(proxy.connected, [[PUBLIC, 80]]);
	const meta = await fetchViaProxy(proxy.port, "http://169.254.169.254/latest/meta-data/");
	assert.equal(meta.status, 403);
	assert.equal(proxy.connected.length, 1);
	await proxy.close();
	await site.close();
});

test("upstream com status HTTP inválido (099, 000) não derruba o proxy: responde 502 e segue atendendo", async () => {
	// Upstream TCP cru: responde uma linha de status que o Node não aceita como status válido (writeHead lançaria).
	const rawUpstream = (statusLine) =>
		new Promise((resolve) => {
			const server = createTcpServer((socket) => {
				socket.on("error", () => undefined);
				socket.once("data", () => socket.end(`${statusLine}\r\n\r\n`));
			});
			server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) }));
		});
	const bad099 = await rawUpstream("HTTP/1.1 099 X");
	const bad000 = await rawUpstream("HTTP/1.1 000 X");
	const site = await origin((_req, res) => res.end("pagina"));
	const proxy = await startProxy({ lookup: async () => [rec(PUBLIC)], origins: { 8081: bad099.port, 8082: bad000.port, default: site.port } });
	try {
		const first = await fetchViaProxy(proxy.port, "http://loja.example:8081/");
		assert.equal(first.status, 502, "status 099 vira 502");
		const second = await fetchViaProxy(proxy.port, "http://loja.example:8082/");
		assert.equal(second.status, 502, "status 000 vira 502");
		const ok = await fetchViaProxy(proxy.port, "http://loja.example/");
		assert.equal(ok.status, 200, "o processo continua vivo e atende a requisição seguinte");
		assert.equal(ok.body, "pagina");
	} finally {
		await proxy.close();
		await site.close();
		await bad099.close();
		await bad000.close();
	}
});

function fetchViaProxy(proxyPort, url) {
	return new Promise((resolve, reject) => {
		const socket = netConnect(proxyPort, "127.0.0.1", () => socket.write(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: close\r\n\r\n`));
		let data = "";
		socket.on("data", (c) => (data += c));
		socket.on("error", reject);
		socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), body: data.split("\r\n\r\n")[1] ?? "" }));
	});
}

// ------------------------------------------------------------ Chromium real

const fixtures = await launchFixtureBrowser({});
after(async () => {
	await fixtures?.close();
});
const skip = fixtures ? false : "Chromium/playwright-core indisponível";

test("Chromium real atrás do proxy: rebinding não adianta, ws:// para IP privado e Worker/fetch internos são barrados", { skip }, async () => {
	const { chromium } = fixtures;
	const site = await origin((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`<html><title>loja</title><body>host=${req.headers.host}</body></html>`);
	});
	let lookups = 0;
	const lookup = async (name) => (name === "rebind.example" ? (++lookups === 1 ? [rec(PUBLIC)] : [rec("127.0.0.1")]) : [rec(PUBLIC)]);
	const proxy = await startProxy({ lookup, origins: { default: site.port } });
	const browser = await chromium.launch({ headless: true, executablePath: fixtures.executablePath, proxy: { server: `http://127.0.0.1:${proxy.port}` }, args: ["--proxy-bypass-list=<-loopback>"] });
	try {
	const page = await (await browser.newContext()).newPage();
	await page.goto("http://rebind.example/", { waitUntil: "domcontentloaded" });
	assert.match(await page.content(), /host=rebind.example/);
	// Cada conexão resolve uma vez e conecta no IP que validou; depois da primeira o nome "virou" 127.0.0.1 e é recusado.
	assert.ok(lookups >= 1);
	assert.ok(proxy.connected.length >= 1 && proxy.connected.every(([ip]) => ip === PUBLIC), JSON.stringify(proxy.connected));

	const outcome = await page.evaluate(async () => {
		const ws = await new Promise((resolve) => {
			const socket = new WebSocket("ws://10.1.2.3:8080/");
			socket.onopen = () => resolve("open");
			socket.onerror = () => resolve("error");
			setTimeout(() => resolve("timeout"), 8000);
		});
		const worker = await new Promise((resolve) => {
			const blob = new Blob([`fetch("http://169.254.169.254/latest/meta-data/").then(() => postMessage("reached"), () => postMessage("blocked"))`]);
			const w = new Worker(URL.createObjectURL(blob));
			w.onmessage = (event) => resolve(event.data);
			setTimeout(() => resolve("timeout"), 8000);
		});
		return { ws, worker };
	});
	assert.notEqual(outcome.ws, "open");
	assert.equal(outcome.worker, "blocked");
	assert.ok(proxy.blocked.some(([, host]) => host === "10.1.2.3"), JSON.stringify(proxy.blocked));
	assert.ok(proxy.blocked.some(([, host]) => host === "169.254.169.254"));
	assert.ok(!proxy.connected.some(([ip]) => ip === "10.1.2.3" || ip === "169.254.169.254"));
	} finally {
		await browser.close();
		await proxy.close();
		await site.close();
	}
});
