import { redactSecrets, type DnsProviderId } from "@workspace/shared";

/**
 * Provedores de DNS da prévia completa. Cada adaptador fala só com o host fixo do seu provedor (nunca uma
 * URL vinda do modelo), com timeout e limite de tamanho; a resposta é dado, e erro nenhum leva o token.
 * Cloudflare: endpoints conferidos na especificação OpenAPI oficial. deSEC: API pública v1 (token `Token`).
 */

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type DnsZone = { id: string; name: string };
export type DnsRecordRef = { id: string; content: string };

export interface DnsProvider {
	readonly id: DnsProviderId;
	/** `false` = o provedor não é escrito pelo Atlas (instruções para o usuário). */
	readonly automated: boolean;
	/** Zona (domínio registrado) que contém `domain`; `null` se o token não enxerga nenhuma. */
	detectZone(domain: string): Promise<DnsZone | null>;
	/** Registro A do curinga `*.<domain>` que já existe (qualquer IP). */
	findWildcard(zone: DnsZone, domain: string): Promise<DnsRecordRef | null>;
	/** Cria `*.<domain>` A → ip; devolve o id para poder desfazer. */
	createWildcard(zone: DnsZone, domain: string, ip: string, opts: { proxied: boolean }): Promise<DnsRecordRef>;
	deleteRecord(zone: DnsZone, recordId: string): Promise<void>;
}

export class DnsProviderError extends Error {
	constructor(message: string, readonly kind: "auth" | "rate_limit" | "not_found" | "conflict" | "other" = "other") {
		super(message);
	}
}

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 15_000;

async function call(fetchFn: FetchFn, token: string, input: { base: string; path: string; method?: string; headers: Record<string, string>; body?: unknown; provider: string }): Promise<{ status: number; json: unknown }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetchFn(`${input.base}${input.path}`, {
			method: input.method ?? "GET",
			headers: { accept: "application/json", ...(input.body !== undefined ? { "content-type": "application/json" } : {}), ...input.headers },
			...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
			signal: controller.signal,
		});
		const raw = (await res.text()).slice(0, MAX_BODY);
		if (res.status === 401 || res.status === 403) throw new DnsProviderError(`${input.provider} recusou o token (inválido ou sem a permissão necessária).`, "auth");
		if (res.status === 429) throw new DnsProviderError(`${input.provider} pediu para esperar (limite de requisições). Tente de novo em alguns minutos.`, "rate_limit");
		let json: unknown = null;
		try {
			json = raw ? JSON.parse(raw) : null;
		} catch {
			json = null;
		}
		if (res.status >= 500) throw new DnsProviderError(`${input.provider} está instável agora (erro ${res.status}).`);
		return { status: res.status, json };
	} catch (error) {
		if (error instanceof DnsProviderError) throw error;
		const aborted = error instanceof Error && error.name === "AbortError";
		throw new DnsProviderError(aborted ? `${input.provider} não respondeu a tempo.` : redactSecrets(`Não consegui falar com ${input.provider}: ${error instanceof Error ? error.message : String(error)}`, [token]).slice(0, 200));
	} finally {
		clearTimeout(timer);
	}
}

/** `a.b.c.com` → ["a.b.c.com", "b.c.com", "c.com"] (do mais específico ao registrável). */
function zoneCandidates(domain: string): string[] {
	const labels = domain.split(".");
	return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
}

function results(json: unknown): Array<Record<string, unknown>> {
	const list = json && typeof json === "object" ? (json as { result?: unknown }).result : null;
	return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

const CF_BASE = "https://api.cloudflare.com/client/v4";

export function cloudflareProvider(token: string, fetchFn: FetchFn): DnsProvider {
	const headers = { authorization: `Bearer ${token}` };
	const cf = (path: string, method = "GET", body?: unknown) => call(fetchFn, token, { base: CF_BASE, path, method, headers, body, provider: "A Cloudflare" });
	return {
		id: "cloudflare",
		automated: true,
		async detectZone(domain) {
			for (const name of zoneCandidates(domain)) {
				const { json } = await cf(`/zones?name=${encodeURIComponent(name)}&per_page=1`);
				const zone = results(json)[0];
				if (zone && typeof zone.id === "string") return { id: zone.id, name: typeof zone.name === "string" ? zone.name : name };
			}
			return null;
		},
		async findWildcard(zone, domain) {
			const { json } = await cf(`/zones/${encodeURIComponent(zone.id)}/dns_records?type=A&name=${encodeURIComponent(`*.${domain}`)}&per_page=1`);
			const rec = results(json)[0];
			return rec && typeof rec.id === "string" ? { id: rec.id, content: String(rec.content ?? "") } : null;
		},
		async createWildcard(zone, domain, ip, opts) {
			const { status, json } = await cf(`/zones/${encodeURIComponent(zone.id)}/dns_records`, "POST", { type: "A", name: `*.${domain}`, content: ip, ttl: 1, proxied: opts.proxied, comment: "Atlas: prévia privada" });
			const rec = json && typeof json === "object" ? ((json as { result?: Record<string, unknown> }).result ?? null) : null;
			if (status >= 300 || !rec || typeof rec.id !== "string") throw new DnsProviderError("A Cloudflare não criou o registro (confira se o token pode editar o DNS desta zona).", "other");
			return { id: rec.id, content: ip };
		},
		async deleteRecord(zone, recordId) {
			const { status } = await cf(`/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(recordId)}`, "DELETE");
			if (status >= 300 && status !== 404) throw new DnsProviderError("A Cloudflare não apagou o registro.");
		},
	};
}

const DESEC_BASE = "https://desec.io/api/v1";

export function desecProvider(token: string, fetchFn: FetchFn): DnsProvider {
	const headers = { authorization: `Token ${token}` };
	const de = (path: string, method = "GET", body?: unknown) => call(fetchFn, token, { base: DESEC_BASE, path, method, headers, body, provider: "O deSEC" });
	/** `*.sub` dentro da zona (`*` quando o domínio é a própria zona). */
	const subname = (zone: DnsZone, domain: string) => {
		const rest = domain === zone.name ? "" : domain.slice(0, -(zone.name.length + 1));
		return rest ? `*.${rest}` : "*";
	};
	return {
		id: "desec",
		automated: true,
		async detectZone(domain) {
			for (const name of zoneCandidates(domain)) {
				const { status, json } = await de(`/domains/?owns_qname=${encodeURIComponent(name)}`);
				const first = status < 300 && Array.isArray(json) ? json[0] : null;
				if (first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string") {
					const zoneName = (first as { name: string }).name;
					return { id: zoneName, name: zoneName };
				}
			}
			return null;
		},
		async findWildcard(zone, domain) {
			const sub = subname(zone, domain);
			const { status, json } = await de(`/domains/${encodeURIComponent(zone.id)}/rrsets/?type=A&subname=${encodeURIComponent(sub)}`);
			const rr = status < 300 && Array.isArray(json) ? json[0] : null;
			if (!rr || typeof rr !== "object") return null;
			const records = (rr as { records?: unknown }).records;
			return { id: `${sub}|A`, content: Array.isArray(records) ? String(records[0] ?? "") : "" };
		},
		async createWildcard(zone, domain, ip) {
			const sub = subname(zone, domain);
			const { status } = await de(`/domains/${encodeURIComponent(zone.id)}/rrsets/`, "POST", { subname: sub, type: "A", ttl: 3600, records: [ip] });
			if (status === 409) throw new DnsProviderError("Já existe um registro neste endereço no deSEC.", "conflict");
			if (status >= 300) throw new DnsProviderError("O deSEC não criou o registro (confira o token).");
			return { id: `${sub}|A`, content: ip };
		},
		async deleteRecord(zone, recordId) {
			const [sub, type] = recordId.split("|");
			if (!sub || type !== "A") throw new DnsProviderError("Registro desconhecido.");
			const { status } = await de(`/domains/${encodeURIComponent(zone.id)}/rrsets/${encodeURIComponent(sub)}/A/`, "DELETE");
			if (status >= 300 && status !== 404) throw new DnsProviderError("O deSEC não apagou o registro.");
		},
	};
}

/** Instrução exata para quem faz o DNS à mão (`manual`) ou num provedor sem adaptador. */
export function manualDnsInstructions(domain: string, ip: string, proxied = false): string {
	return [
		`Create ONE DNS record at the provider that manages the domain: type A, name "*.${domain}" (a wildcard; if the panel only takes a relative name use "*" for the zone ${domain} or "*.<part before the zone>"), value ${ip}, TTL automatic or 300-3600${proxied ? ", proxy ON (orange cloud)" : ", proxy OFF (DNS only)"}.`,
		`Also fine to add the same A record for "${domain}" itself, but it is not required.`,
	].join(" ");
}
