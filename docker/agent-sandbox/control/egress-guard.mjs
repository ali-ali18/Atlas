// Regras de SSRF/egress do Chromium da VM (F8.0): quais endereços e nomes são internos. Bloqueia metadata de nuvem
// (169.254.169.254), loopback, RFC1918, link-local, CGNAT, IPv6 que não é unicast global e a rede Docker (172.16/12). Nada de
// nome específico de loja ou provedor.
// ONDE É IMPOSTO: a barreira de verdade é o PROXY LOCAL (`egress-proxy.mjs`): o Chromium sai só por ele, que valida o IP já
// resolvido e conecta nesse IP (HTTP, HTTPS, WebSocket e Service Worker). O `installEgressGuard` abaixo (context.route) é só
// DEFESA EXTRA: ele julga a URL antes de o Chromium resolver o DNS, então sozinho NÃO barra DNS rebinding (o nome responde
// público aqui e privado na conexão real). Não confie nele como única camada.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const V4_BLOCKED = [
	[0, 8], // "esta rede"
	[10 * 2 ** 24, 8], // RFC1918
	[100 * 2 ** 24 + 64 * 2 ** 16, 10], // 100.64/10 CGNAT
	[127 * 2 ** 24, 8], // loopback
	[169 * 2 ** 24 + 254 * 2 ** 16, 16], // link-local + metadata
	[172 * 2 ** 24 + 16 * 2 ** 16, 12], // RFC1918 + rede Docker (172.17/16)
	[192 * 2 ** 24, 24], // 192.0.0/24 protocolo IETF
	[192 * 2 ** 24 + 168 * 2 ** 16, 16], // RFC1918
	[198 * 2 ** 24 + 18 * 2 ** 16, 15], // benchmark
	[224 * 2 ** 24, 4], // multicast
	[240 * 2 ** 24, 4], // reservado + broadcast
];

function v4ToInt(ip) {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
	return parts[0] * 2 ** 24 + parts[1] * 2 ** 16 + parts[2] * 2 ** 8 + parts[3];
}

/** IPv6 em 8 grupos de 16 bits (aceita `::` e v4 embutido). `null` se inválido. */
function v6Groups(ip) {
	let text = ip.toLowerCase().split("%")[0];
	const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (tail) {
		const n = v4ToInt(tail[1]);
		if (n === null) return null;
		text = text.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => Number.parseInt(g, 16));
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** O endereço (v4 ou v6) NÃO é público? Inválido conta como bloqueado (fail-closed). */
export function isBlockedIp(address) {
	const ip = String(address ?? "").trim().replace(/^\[|\]$/g, "");
	const kind = isIP(ip);
	if (kind === 4) {
		const n = v4ToInt(ip);
		if (n === null) return true;
		return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
	}
	if (kind === 6) {
		const g = v6Groups(ip);
		if (!g) return true;
		// v4 mapeado (::ffff:a.b.c.d) e compatível/NAT64: vale o v4 embutido.
		const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
		if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIp(embedded());
		if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIp(embedded());
		// Só 2000::/3 é unicast global; fora disso (::, ::1, fe80::/10, fc00::/7, ff00::/8...) é bloqueado.
		if ((g[0] & 0xe000) !== 0x2000) return true;
		if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentação
		if (g[0] === 0x2002) return isBlockedIp(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4 embute o v4
		return false;
	}
	return true;
}

/** Nome que nunca é um site público: localhost, `.internal`/`.local`, serviços do Docker (sem ponto) e metadata. */
export function isBlockedHostname(host) {
	const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!name) return true;
	if (isIP(name.replace(/^\[|\]$/g, ""))) return false; // IP literal é julgado por `isBlockedIp`
	if (!name.includes(".")) return true;
	return name === "localhost" || /\.(localhost|local|internal|localdomain|lan|home\.arpa)$/.test(name) || name === "host.docker.internal";
}

// Sem `file:` (leria arquivos da VM) e sem `ftp:` (protocolo sem proxy HTTP). Só o que não toca a rede passa sem checagem.
const NON_NETWORK = new Set(["about:", "data:", "blob:", "chrome-extension:"]);
const NETWORK = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * `lookup(host)` devolve todos os endereços do nome (injetável em teste). Cache curto por nome só para não resolver a
 * cada subrecurso da mesma página; passou o TTL, resolve de novo (um nome que passa a apontar para rede interna é pego).
 */
export function createEgressGuard({ lookup = (host) => dnsLookup(host, { all: true, verbatim: true }), now = Date.now, ttlMs = 5000 } = {}) {
	const cache = new Map();
	async function resolveAll(host) {
		const hit = cache.get(host);
		if (hit && now() - hit.at < ttlMs) return hit.addresses;
		const found = await lookup(host);
		const addresses = (Array.isArray(found) ? found : [found]).map((entry) => (typeof entry === "string" ? entry : entry?.address)).filter(Boolean);
		cache.set(host, { at: now(), addresses });
		if (cache.size > 500) cache.delete(cache.keys().next().value);
		return addresses;
	}
	return {
		/** `{ ok: true }` ou `{ ok: false, reason }` (motivo curto, sem a URL: ela pode levar token em query). */
		async check(rawUrl) {
			let url;
			try {
				url = new URL(String(rawUrl));
			} catch {
				return { ok: false, reason: "invalid URL" };
			}
			if (NON_NETWORK.has(url.protocol)) return { ok: true };
			if (!NETWORK.has(url.protocol)) return { ok: false, reason: `scheme ${url.protocol} not allowed` };
			if (url.username || url.password) return { ok: false, reason: "credentials in URL" };
			const host = url.hostname.replace(/^\[|\]$/g, "");
			if (isIP(host)) return isBlockedIp(host) ? { ok: false, reason: "private or reserved address" } : { ok: true };
			if (isBlockedHostname(host)) return { ok: false, reason: "internal host name" };
			let addresses;
			try {
				addresses = await resolveAll(host);
			} catch {
				return { ok: false, reason: "host did not resolve" };
			}
			if (addresses.length === 0) return { ok: false, reason: "host did not resolve" };
			return addresses.some(isBlockedIp) ? { ok: false, reason: "host resolves to a private or reserved address" } : { ok: true };
		},
	};
}

/**
 * DEFESA EXTRA (a barreira é o proxy local): liga o guarda a um contexto do Playwright: cada requisição (inclusive redirecionamento, que chega como requisição nova)
 * é conferida e abortada se o destino é interno. Falhou em conferir = aborta (fail-closed).
 */
export async function installEgressGuard(context, guard = createEgressGuard(), onBlock = () => undefined) {
	await context.route("**/*", async (route) => {
		let verdict;
		try {
			verdict = await guard.check(route.request().url());
		} catch {
			verdict = { ok: false, reason: "egress check failed" };
		}
		if (verdict.ok) return route.fallback();
		onBlock(verdict.reason);
		return route.abort("blockedbyclient");
	});
}
