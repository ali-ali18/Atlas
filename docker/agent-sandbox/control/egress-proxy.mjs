// Proxy de saída LOCAL da VM (F8 auditoria #2): o Chromium sai SÓ por aqui (`--proxy-server`, ver bin/atlas-chrome), então a
// barreira vale para TUDO que o navegador faz: navegação, subrecurso, WebSocket (ws:// e wss:// viram CONNECT), fetch de
// Service Worker e de Worker. É a mesma regra do `egress-guard.mjs` (IP bloqueado, nome interno), mas aplicada NA CONEXÃO:
//   1. resolve o nome UMA vez;
//   2. se QUALQUER endereço for interno, recusa;
//   3. conecta no IP que acabou de ser validado (nunca resolve de novo): um DNS que responde público ao guarda e privado depois
//      (rebinding) não adianta, porque o navegador nem resolve o nome (quem resolve é este proxy).
// Escuta só em 127.0.0.1. Sem dependências. O `context.route` do Playwright continua como defesa extra, mas NÃO é a barreira:
// ele julga a URL antes de o Chromium resolver o DNS por conta própria.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { isBlockedHostname, isBlockedIp } from "./egress-guard.mjs";

export const DEFAULT_PROXY_PORT = 3128;
const BLOCKED_PORTS = new Set([25, 465, 587]); // e-mail de saída: nada de spam pela VM
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 120_000;
const HOP_HEADERS = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "upgrade", "transfer-encoding"]);

const bareHost = (host) => String(host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/**
 * Resolve e valida o destino. `{ ok: true, address, family }` com o IP a conectar, ou `{ ok: false, reason }`.
 * `lookup(host)` devolve todos os registros (injetável em teste).
 */
export async function resolveAllowed(host, port, lookup = (name) => dnsLookup(name, { all: true, verbatim: true })) {
	const name = bareHost(host);
	if (!name) return { ok: false, reason: "invalid host" };
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "invalid port" };
	if (BLOCKED_PORTS.has(port)) return { ok: false, reason: "port not allowed" };
	if (isIP(name)) return isBlockedIp(name) ? { ok: false, reason: "private or reserved address" } : { ok: true, address: name, family: isIP(name) };
	if (isBlockedHostname(name)) return { ok: false, reason: "internal host name" };
	let records;
	try {
		const found = await lookup(name);
		records = (Array.isArray(found) ? found : [found]).map((entry) => (typeof entry === "string" ? { address: entry, family: isIP(entry) } : entry)).filter((entry) => entry?.address);
	} catch {
		return { ok: false, reason: "host did not resolve" };
	}
	if (records.length === 0) return { ok: false, reason: "host did not resolve" };
	if (records.some((entry) => isBlockedIp(entry.address))) return { ok: false, reason: "host resolves to a private or reserved address" };
	// Prefere IPv4 (a VM costuma não ter rota IPv6).
	const pick = records.find((entry) => entry.family === 4 || isIP(entry.address) === 4) ?? records[0];
	return { ok: true, address: pick.address, family: isIP(pick.address) };
}

function parseAuthority(text) {
	const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(String(text ?? ""));
	return match ? { host: match[1] ?? match[2], port: match[3] ? Number(match[3]) : undefined } : null;
}

/** Proxy HTTP (CONNECT + http:// absoluto). `connect` é injetável: recebe `{ host: <IP validado>, port }`. */
export function createGuardedProxy({ lookup, connect = netConnect, onBlock = () => undefined } = {}) {
	const deny = (reason, host) => {
		onBlock(reason, bareHost(host));
		return reason;
	};

	const server = createServer(async (req, res) => {
		req.on("error", () => res.destroy());
		res.on("error", () => undefined);
		const refuse = (status, reason) => {
			res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
			res.end(`Blocked by the computer's egress guard: ${reason}\n`);
		};
		let target;
		try {
			target = new URL(req.url ?? "");
		} catch {
			return refuse(400, "absolute URL required");
		}
		if (target.protocol !== "http:") return refuse(400, "only http:// or CONNECT");
		if (target.username || target.password) return refuse(403, deny("credentials in URL", target.hostname));
		const port = Number(target.port || 80);
		const verdict = await resolveAllowed(target.hostname, port, lookup);
		if (!verdict.ok) return refuse(403, deny(verdict.reason, target.hostname));
		const headers = {};
		for (const [key, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
		headers.host = target.host;
		// A conexão vai para o IP VALIDADO; o nome só segue no cabeçalho Host.
		const upstream = httpRequest({ host: verdict.address, port, method: req.method, path: `${target.pathname}${target.search}`, headers, createConnection: () => connect({ host: verdict.address, port }) }, (response) => {
			res.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(res);
		});
		upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
		upstream.on("error", () => (res.headersSent ? res.destroy() : refuse(502, "upstream unreachable")));
		req.pipe(upstream);
	});

	// CONNECT: https, wss e ws (o Chromium usa CONNECT para WebSocket atrás de proxy HTTP).
	server.on("connect", async (req, clientSocket, head) => {
		clientSocket.on("error", () => clientSocket.destroy());
		const refuse = (status, reason) => {
			clientSocket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by the computer's egress guard: ${reason}\n`);
		};
		const authority = parseAuthority(req.url);
		if (!authority?.port) return refuse(400, "host:port required");
		const verdict = await resolveAllowed(authority.host, authority.port, lookup);
		if (!verdict.ok) return refuse(403, deny(verdict.reason, authority.host));
		const upstream = connect({ host: verdict.address, port: authority.port });
		let opened = false;
		const timer = setTimeout(() => upstream.destroy(), CONNECT_TIMEOUT_MS);
		upstream.once("connect", () => {
			opened = true;
			clearTimeout(timer);
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head?.length) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
			upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
		});
		upstream.on("error", () => {
			clearTimeout(timer);
			if (opened) clientSocket.destroy();
			else refuse(502, "upstream unreachable");
		});
		upstream.on("close", () => clientSocket.destroy());
		clientSocket.on("close", () => upstream.destroy());
	});

	return {
		server,
		/** Escuta só no loopback. Devolve a porta efetiva. */
		listen: (port = DEFAULT_PROXY_PORT) => new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve(server.address().port));
		}),
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
