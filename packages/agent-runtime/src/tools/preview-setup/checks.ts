import { Resolver } from "node:dns/promises";
import tls from "node:tls";
import { previewProbeHost } from "@workspace/shared";

/**
 * Verificações reais de cada passo (DNS, certificado, resposta da API). Tudo injetável em teste; nenhuma
 * escreve nada. O DNS usa resolvedores públicos próprios (um Resolver novo a cada chamada, sem cache do sistema).
 */

export type DnsCheck = { ok: boolean; reason?: "no_record" | "wrong_ip" | "error"; found: string[] };
export type TlsCheck = { ok: boolean; reason?: "unreachable" | "untrusted" | "expired" | "san_mismatch"; issuer?: string; validTo?: string };
export type ProbeCheck = { kind: "ok" | "route_missing" | "not_enabled" | "unreachable" | "tls_error"; status?: number };

export type Checks = {
	dns(host: string, expectedIp: string | null): Promise<DnsCheck>;
	tls(host: string, baseDomain: string): Promise<TlsCheck>;
	probe(baseDomain: string): Promise<ProbeCheck>;
};

/** `expectedIp = null`: com o proxy da Cloudflare ligado resolve para IPs da Cloudflare; basta existir resposta. */
export async function checkDns(host: string, expectedIp: string | null, resolve4: (host: string) => Promise<string[]> = defaultResolve4): Promise<DnsCheck> {
	let found: string[];
	try {
		found = await resolve4(host);
	} catch (error) {
		const code = (error as { code?: string }).code;
		return { ok: false, reason: code === "ENOTFOUND" || code === "ENODATA" ? "no_record" : "error", found: [] };
	}
	if (expectedIp === null ? found.length > 0 : found.includes(expectedIp)) return { ok: true, found };
	return { ok: false, reason: found.length ? "wrong_ip" : "no_record", found };
}

async function defaultResolve4(host: string): Promise<string[]> {
	const resolver = new Resolver({ timeout: 4_000, tries: 1 });
	resolver.setServers(["1.1.1.1", "8.8.8.8"]);
	return resolver.resolve4(host);
}

/** `*.base` cobre `host`? (um nível, como manda o certificado curinga) */
export function sanCovers(san: string, baseDomain: string): boolean {
	const names = san.split(",").map((s) => s.trim().replace(/^DNS:/i, "").toLowerCase());
	return names.some((n) => n === `*.${baseDomain}`);
}

export type PeerCert = { subjectaltname?: string; valid_to?: string; issuer?: { O?: string; CN?: string } };

export function checkTlsFromCert(input: { authorized: boolean; cert: PeerCert | null; baseDomain: string; now: number }): TlsCheck {
	const { cert } = input;
	if (!cert || !cert.valid_to) return { ok: false, reason: "unreachable" };
	const issuer = cert.issuer?.O ?? cert.issuer?.CN;
	const validTo = cert.valid_to;
	if (Date.parse(validTo) <= input.now) return { ok: false, reason: "expired", issuer, validTo };
	if (!sanCovers(cert.subjectaltname ?? "", input.baseDomain)) return { ok: false, reason: "san_mismatch", issuer, validTo };
	if (!input.authorized) return { ok: false, reason: "untrusted", issuer, validTo };
	return { ok: true, issuer, validTo };
}

export function checkTls(host: string, baseDomain: string, now: () => number = Date.now): Promise<TlsCheck> {
	return new Promise((resolve) => {
		const socket = tls.connect({ host, servername: host, port: 443, rejectUnauthorized: false, timeout: 8_000 }, () => {
			const cert = socket.getPeerCertificate() as PeerCert;
			const result = checkTlsFromCert({ authorized: socket.authorized, cert: cert && Object.keys(cert).length ? cert : null, baseDomain, now: now() });
			socket.destroy();
			resolve(result);
		});
		socket.once("timeout", () => { socket.destroy(); resolve({ ok: false, reason: "unreachable" }); });
		socket.once("error", () => { socket.destroy(); resolve({ ok: false, reason: "unreachable" }); });
	});
}

/**
 * GET no endereço de entrada de uma prévia inexistente: a API do Atlas (com a prévia ligada) responde 401 com o
 * texto "Link expirado"; o proxy sem rota responde o 404 dele; a API sem a variável cai nas rotas normais.
 */
export async function probeApi(baseDomain: string, fetchFn: typeof fetch = fetch): Promise<ProbeCheck> {
	const url = `https://${previewProbeHost(baseDomain)}/__atlas_preview_auth`;
	try {
		const res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "text/plain" } });
		const body = (await res.text()).slice(0, 2_000);
		if (res.status === 401 && body.includes("Link expirado")) return { kind: "ok", status: 401 };
		if (res.status === 404 && /^404 page not found/i.test(body.trim())) return { kind: "route_missing", status: 404 };
		if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: "route_missing", status: res.status };
		return { kind: "not_enabled", status: res.status };
	} catch (error) {
		const code = String((error as { cause?: { code?: string } }).cause?.code ?? "");
		return { kind: /CERT|SSL|TLS|ALTNAME/i.test(code) ? "tls_error" : "unreachable" };
	}
}

export function defaultChecks(): Checks {
	return {
		dns: (host, ip) => checkDns(host, ip),
		tls: (host, base) => checkTls(host, base),
		probe: (base) => probeApi(base),
	};
}
