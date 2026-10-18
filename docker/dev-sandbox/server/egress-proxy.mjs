import { createServer, request as httpRequest } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP } from "node:net";

// Proxy de saída (HTTP CONNECT + HTTP simples) que aplica a política de internet
// da sessão: `full` (sem proxy), `allowlist` (só domínios listados) ou `off`
// (nada). Sem dependências. É "melhor esforço": ferramentas que respeitam
// HTTP(S)_PROXY (git, npm, pnpm, pip, curl, gh) passam por aqui; um processo
// que ignore a variável ainda sai direto (sem NET_ADMIN não há iptables).

export const EGRESS_MODES = ["full", "allowlist", "off"];
export const PROXY_HOST = "127.0.0.1";
export const PROXY_PORT = 3128;
const ALLOWED_PORTS = new Set([80, 443]);
const MAX_ALLOWLIST = 200;

/** Domínio sem esquema/porta, minúsculo; `*.exemplo.com` vale para subdomínios (e não para o próprio apex). */
export function normalizePattern(raw) {
	if (typeof raw !== "string") return null;
	let value = raw.trim().toLowerCase();
	value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
	if (!value) return null;
	const wildcard = value.startsWith("*.");
	const host = wildcard ? value.slice(2) : value;
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
	return wildcard ? `*.${host}` : host;
}

export function normalizeAllowlist(list) {
	const out = [];
	for (const item of Array.isArray(list) ? list : []) {
		const pattern = normalizePattern(item);
		if (pattern && !out.includes(pattern)) out.push(pattern);
		if (out.length >= MAX_ALLOWLIST) break;
	}
	return out;
}

/** `host` casa com algum padrão? IPs literais nunca casam com domínio (só com padrão idêntico). */
export function hostAllowed(host, patterns) {
	const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!h) return false;
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (isIP(h)) continue;
			if (h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1) return true;
		} else if (h === pattern) {
			return true;
		}
	}
	return false;
}

/** Endereço de rede interna/loopback/link-local/metadata: o proxy de rede nunca conecta nesses destinos. */
export function isPrivateAddress(address) {
	const a = String(address ?? "").toLowerCase().replace(/^::ffff:/, "");
	if (isIP(a) === 4) {
		const [p, q] = a.split(".").map(Number);
		return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
	}
	if (isIP(a) === 6) return a === "::" || a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb");
	return true;
}

export function createEgressPolicy(initial = {}) {
	let mode = EGRESS_MODES.includes(initial.mode) ? initial.mode : "full";
	let allowlist = normalizeAllowlist(initial.allowlist);
	return {
		get() {
			return { mode, allowlist: [...allowlist] };
		},
		set(next) {
			if (!EGRESS_MODES.includes(next?.mode)) throw Object.assign(new Error("mode inválido"), { status: 400 });
			mode = next.mode;
			allowlist = normalizeAllowlist(next.allowlist);
			return { mode, allowlist: [...allowlist] };
		},
		/** Resultado da checagem de um destino. */
		check(host, port) {
			if (mode === "full") return { ok: true };
			if (mode === "off") return { ok: false, reason: "internet desativada para esta sessão" };
			if (port !== undefined && !ALLOWED_PORTS.has(port)) return { ok: false, reason: `porta ${port} não permitida` };
			return hostAllowed(host, allowlist) ? { ok: true } : { ok: false, reason: `domínio ${host} fora da lista liberada` };
		},
		/** Variáveis de proxy para o ambiente dos comandos (vazio no modo `full`). */
		env() {
			if (mode === "full") return {};
			const url = process.env.DEV_EGRESS_PROXY_URL || `http://${PROXY_HOST}:${PROXY_PORT}`;
			const noProxy = "localhost,127.0.0.1,::1";
			return {
				HTTP_PROXY: url,
				HTTPS_PROXY: url,
				http_proxy: url,
				https_proxy: url,
				ALL_PROXY: url,
				NO_PROXY: noProxy,
				no_proxy: noProxy,
				NODE_USE_ENV_PROXY: "1",
			};
		},
	};
}

function deny(socketOrRes, reason, isSocket) {
	const body = `Bloqueado pelo proxy de saída: ${reason}\n`;
	if (isSocket) {
		socketOrRes.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
	} else {
		socketOrRes.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
		socketOrRes.end(body);
	}
}

/** Sobe o proxy. `connect` é injetável em teste. */
export function createEgressProxy(policy, options = {}) {
	const connectFn = options.connect ?? netConnect;
	// Modo gateway (rede interna): resolve o nome aqui e recusa destinos privados (rebinding de DNS).
	const resolveSafe = options.blockPrivate
		? async (host) => {
				if (isIP(host)) {
					if (isPrivateAddress(host)) throw new Error("destino em rede privada");
					return host;
				}
				// Qualquer registro privado recusa o destino; prefere IPv4 (redes Docker costumam não ter rota IPv6).
				const records = await dnsLookup(host, { all: true });
				if (!records.length || records.some((item) => isPrivateAddress(item.address))) throw new Error("destino em rede privada");
				return (records.find((item) => item.family === 4) ?? records[0]).address;
			}
		: async (host) => host;
	const sourceOf = (socket) => String(socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
	const server = createServer((req, res) => {
		req.on("error", () => res.destroy());
		res.on("error", () => undefined);
		let target;
		try {
			target = new URL(req.url ?? "");
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		if (target.protocol !== "http:") {
			deny(res, "só http:// ou CONNECT são aceitos", false);
			return;
		}
		const port = Number(target.port || 80);
		const verdict = policy.check(target.hostname, port, sourceOf(req.socket));
		if (!verdict.ok) {
			deny(res, verdict.reason, false);
			return;
		}
		const headers = { ...req.headers };
		delete headers["proxy-connection"];
		delete headers["proxy-authorization"];
		resolveSafe((target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname)).then(
			(address) => {
				const upstream = httpRequest(
					{ host: address, port, method: req.method, path: target.pathname + target.search, headers },
					(response) => {
						res.writeHead(response.statusCode ?? 502, response.headers);
						response.pipe(res);
					},
				);
				upstream.on("error", () => {
					if (!res.headersSent) res.writeHead(502);
					res.end();
				});
				req.pipe(upstream);
			},
			() => deny(res, "destino inacessível ou em rede privada", false),
		);
	});

	server.on("connect", (req, clientSocket, head) => {
		// Cliente que derruba a conexão (ex.: curl depois de um 403) não pode derrubar o servidor.
		clientSocket.on("error", () => clientSocket.destroy());
		const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
		if (!match) {
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const host = match[1].replace(/^\[|\]$/g, "");
		const port = Number(match[2]);
		const verdict = policy.check(host, port, sourceOf(clientSocket));
		if (!verdict.ok) {
			deny(clientSocket, verdict.reason, true);
			return;
		}
		let upstream = null;
		const close = () => {
			upstream?.destroy();
			clientSocket.destroy();
		};
		clientSocket.on("close", close);
		resolveSafe(host).then(
			(address) => {
				if (clientSocket.destroyed) return;
				upstream = connectFn(port, address, () => {
					clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					if (head?.length) upstream.write(head);
					upstream.pipe(clientSocket);
					clientSocket.pipe(upstream);
				});
				upstream.on("error", () => {
					if (!clientSocket.writableEnded) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
					close();
				});
			},
			() => deny(clientSocket, "destino inacessível ou em rede privada", true),
		);
	});

	return {
		server,
		listen(port = PROXY_PORT, host = PROXY_HOST) {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => resolve(server.address()));
			});
		},
		close() {
			server.close();
		},
	};
}
