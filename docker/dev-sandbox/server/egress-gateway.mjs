import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createEgressPolicy, createEgressProxy, EGRESS_MODES, normalizeAllowlist } from "./egress-proxy.mjs";

// Gateway de saída compartilhado (container separado). Os containers de sessão
// ficam numa rede Docker `internal` (sem rota para a internet) e só chegam ao
// mundo por aqui. Cada sessão é identificada pelo IP de origem na rede interna;
// o gerenciador registra a política de cada IP por um endpoint de controle
// autenticado. IP desconhecido = tudo negado.

export function normalizeSourceIp(raw) {
	const value = String(raw ?? "").trim().replace(/^::ffff:/, "");
	return isIP(value) ? value : null;
}

/** Mapa IP de origem -> política da sessão. */
export function createSessionPolicies() {
	const sessions = new Map();
	return {
		set(ip, next) {
			const key = normalizeSourceIp(ip);
			if (!key) throw Object.assign(new Error("ip inválido"), { status: 400 });
			if (!EGRESS_MODES.includes(next?.mode)) throw Object.assign(new Error("mode inválido"), { status: 400 });
			const policy = createEgressPolicy({ mode: next.mode, allowlist: normalizeAllowlist(next.allowlist) });
			sessions.set(key, { sessionId: typeof next.sessionId === "string" ? next.sessionId.slice(0, 80) : undefined, policy });
			return { ip: key, ...policy.get() };
		},
		remove(ip) {
			const key = normalizeSourceIp(ip);
			return key ? sessions.delete(key) : false;
		},
		list() {
			return [...sessions.entries()].map(([ip, entry]) => ({ ip, sessionId: entry.sessionId, ...entry.policy.get() }));
		},
		/** Interface esperada por `createEgressProxy`: decide pelo IP de origem. */
		check(host, port, sourceIp) {
			const entry = sessions.get(normalizeSourceIp(sourceIp) ?? "");
			if (!entry) return { ok: false, reason: "sessão não registrada no gateway" };
			return entry.policy.check(host, port);
		},
	};
}

function isAuthorized(header, token) {
	if (!token || typeof header !== "string") return false;
	const match = /^Bearer (.+)$/.exec(header);
	if (!match) return false;
	const given = Buffer.from(match[1]);
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 256 * 1024) throw Object.assign(new Error("corpo grande demais"), { status: 413 });
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("JSON inválido"), { status: 400 });
	}
}

/** Endpoint de controle: `PUT /sessions/:ip`, `DELETE /sessions/:ip`, `GET /sessions`, `GET /health`. */
export function createControlServer({ token, sessions }) {
	return createServer(async (req, res) => {
		const send = (status, body) => {
			res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			res.end(JSON.stringify(body));
		};
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (req.method === "GET" && path === "/health") return send(200, { ok: true });
		if (!isAuthorized(req.headers.authorization, token)) return send(401, { error: "unauthorized" });
		try {
			if (req.method === "GET" && path === "/sessions") return send(200, { sessions: sessions.list() });
			const match = /^[/]sessions[/]([^/]+)$/.exec(path);
			if (match && req.method === "PUT") return send(200, sessions.set(decodeURIComponent(match[1]), await readJson(req)));
			if (match && req.method === "DELETE") return send(200, { removed: sessions.remove(decodeURIComponent(match[1])) });
			return send(404, { error: "not found" });
		} catch (error) {
			return send(error?.status ?? 500, { error: error?.status ? error.message : "erro interno" });
		}
	});
}

/** Sobe o proxy (todas as interfaces) e o controle. */
export async function startGateway({ token, proxyPort = 3128, controlPort = 3129, host = "0.0.0.0" } = {}) {
	const sessions = createSessionPolicies();
	const proxy = createEgressProxy(sessions, { blockPrivate: true });
	const control = createControlServer({ token, sessions });
	await proxy.listen(proxyPort, host);
	await new Promise((resolve, reject) => {
		control.once("error", reject);
		control.listen(controlPort, host, resolve);
	});
	return { sessions, proxy, control };
}
