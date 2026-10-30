/**
 * Configuração da prévia completa pelo bot (domínio, DNS curinga, certificado, rota, variável, redeploy):
 * estado e regras puras (sem I/O). Os adaptadores e a máquina de passos ficam em
 * `packages/agent-runtime/src/tools/preview-setup/`; a persistência em `packages/db/src/preview-setup.ts`.
 */
import { normalizePreviewBaseDomain, previewBaseDomainConflict } from "./preview.js";

export const SETUP_STEPS = ["dns", "tls", "route", "env", "redeploy", "probe"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const DNS_PROVIDERS = ["cloudflare", "desec", "manual"] as const;
export type DnsProviderId = (typeof DNS_PROVIDERS)[number];

export const TLS_STRATEGIES = ["dns01-proxy", "origin-cert"] as const;
export type TlsStrategyId = (typeof TLS_STRATEGIES)[number];

export const SETUP_PLATFORMS = ["dokploy", "generic"] as const;
export type SetupPlatformId = (typeof SETUP_PLATFORMS)[number];

/** Nomes dos segredos no cofre do dono (o modelo nunca vê os valores). */
export const SETUP_SECRET_DNS_TOKEN = "preview-dns-token";

/** pending = ainda não tentou; awaiting_user = o usuário precisa fazer algo fora do Atlas; done; failed. */
export type SetupStepStatus = "pending" | "awaiting_user" | "done" | "failed";

export type SetupStepState = {
	status: SetupStepStatus;
	/** Frase curta (pt-BR) do último resultado; nunca guarda segredo. */
	detail?: string;
	updatedAt?: string;
	/** Ids criados por este passo (para desfazer só o que o setup criou). */
	created?: { zoneId?: string; recordIds?: string[] };
	/** Gravado ANTES de escrever fora: se o processo cair no meio, a retomada reconhece o registro como nosso. */
	intent?: "creating";
};

export type PreviewSetupState = {
	v: 1;
	domain: string;
	dnsProvider: DnsProviderId;
	tls: TlsStrategyId;
	platform: SetupPlatformId;
	/** IP público do servidor (registro A do curinga). */
	serverIp: string;
	/** Sobe a cada escrita executada: a aprovação (callKey) vale uma vez; desfazer e refazer pede cartão novo. */
	approvalSeq?: number;
	steps: Record<SetupStepId, SetupStepState>;
};

/** Rótulos para o usuário (sem jargão). */
export const SETUP_STEP_LABEL: Record<SetupStepId, string> = {
	dns: "Endereço curinga no DNS",
	tls: "Certificado de segurança (HTTPS)",
	route: "Rota até o Atlas",
	env: "Domínio nas configurações do servidor",
	redeploy: "Reinício do servidor",
	probe: "Teste final",
};

export function isDnsProvider(value: unknown): value is DnsProviderId {
	return typeof value === "string" && (DNS_PROVIDERS as readonly string[]).includes(value);
}
export function isTlsStrategy(value: unknown): value is TlsStrategyId {
	return typeof value === "string" && (TLS_STRATEGIES as readonly string[]).includes(value);
}
export function isSetupPlatform(value: unknown): value is SetupPlatformId {
	return typeof value === "string" && (SETUP_PLATFORMS as readonly string[]).includes(value);
}

/** IPv4 público (recusa privado, loopback, link-local, CGNAT e reservado). */
export function isPublicIpv4(value: unknown): value is string {
	if (typeof value !== "string") return false;
	// Forma canônica: sem espaço e sem zero à esquerda ("010.0.0.1" pode ser lido como octal por outros programas).
	const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
	if (!m) return false;
	const o = m.slice(1).map(Number) as [number, number, number, number];
	if (o.some((n) => n > 255)) return false;
	const [a, b] = o;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	return true;
}

/** IPv4 público informado pelo usuário: tira espaços das pontas e exige a forma canônica; `null` se inválido. */
export function normalizeServerIp(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const ip = raw.trim();
	return isPublicIpv4(ip) ? ip : null;
}

/** Texto de terceiros (provedor, página) entre aspas e sem controle/quebra de linha, para entrar em mensagem ao modelo como dado. */
export function quoteUntrusted(value: unknown, max = 80): string {
	// eslint-disable-next-line no-control-regex
	const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
	return JSON.stringify(clean);
}

/** Domínio-base da prévia: forma válida, sem porta, não é IP/localhost e não cai no mesmo site do Atlas. `error` em pt-BR. */
export function validateSetupDomain(raw: unknown, atlasUrls: string | ReadonlyArray<string | undefined>): { domain: string } | { error: string } {
	if (typeof raw !== "string") return { error: "Informe o domínio das prévias (ex.: previas.exemplo.com)." };
	// Falha fechada: sem o endereço do Atlas não dá para provar que o domínio é um site separado.
	const urls = (typeof atlasUrls === "string" ? [atlasUrls] : [...atlasUrls]).map((u) => u?.trim()).filter((u): u is string => Boolean(u));
	const primary = urls[0];
	let primaryOk = false;
	try {
		primaryOk = Boolean(primary && new URL(primary).hostname);
	} catch {
		primaryOk = false;
	}
	if (!primaryOk) return { error: "Não consigo conferir se o domínio é separado do Atlas porque o endereço do Atlas (ATLAS_URL) não está configurado neste servidor. Configure-o e tente de novo." };
	const domain = normalizePreviewBaseDomain(raw);
	if (domain && domain.length > 253) return { error: "Esse domínio é longo demais (máximo de 253 caracteres)." };
	if (!domain || domain.includes(":") || !domain.includes(".") || /^\d+(\.\d+){3}$/.test(domain) || domain === "localhost") {
		return { error: "Esse domínio não parece válido. Use algo como previas.exemplo.com (sem https:// e sem porta)." };
	}
	// O Atlas pode ter mais de um endereço (api, web, login): todos precisam ser de outro site.
	let conflict: string | null = null;
	for (const url of urls) {
		let valid = true;
		try {
			new URL(url);
		} catch {
			valid = false;
		}
		if (!valid) return { error: `Um dos endereços do Atlas configurados no servidor é inválido (${quoteUntrusted(url, 60)}); corrija-o antes de configurar a prévia.` };
		conflict ??= previewBaseDomainConflict(domain, url);
	}
	if (conflict) return { error: `Não dá para usar esse domínio: ${conflict}. Use um domínio separado do Atlas (por exemplo outro domínio, ou um grátis como seunome.dedyn.io).` };
	return { domain };
}

/** Host de teste que o proxy da API reconhece como prévia (`<id>.<base>`, id de 20-40 letras/números). */
export function previewProbeHost(baseDomain: string): string {
	return `atlasprobe000000000000.${baseDomain}`;
}

export function emptySetupSteps(): Record<SetupStepId, SetupStepState> {
	return Object.fromEntries(SETUP_STEPS.map((id) => [id, { status: "pending" as SetupStepStatus }])) as Record<SetupStepId, SetupStepState>;
}

export function createSetupState(input: { domain: string; dnsProvider: DnsProviderId; tls: TlsStrategyId; platform: SetupPlatformId; serverIp: string }): PreviewSetupState {
	return { v: 1, ...input, steps: emptySetupSteps() };
}

/** Primeiro passo que ainda não terminou (os passos são sequenciais); `null` = tudo pronto. */
export function nextSetupStep(state: PreviewSetupState): SetupStepId | null {
	return SETUP_STEPS.find((id) => state.steps[id].status !== "done") ?? null;
}

export function isSetupComplete(state: PreviewSetupState): boolean {
	return nextSetupStep(state) === null;
}

export function withStep(state: PreviewSetupState, id: SetupStepId, patch: Partial<SetupStepState>, now: Date): PreviewSetupState {
	return { ...state, steps: { ...state.steps, [id]: { ...state.steps[id], ...patch, updatedAt: now.toISOString() } } };
}

/** Ids criados pelo setup que podem ser desfeitos (só DNS escreve em sistema externo). */
export function rollbackTargets(state: PreviewSetupState): { zoneId: string; recordIds: string[] } | null {
	const created = state.steps.dns.created;
	if (!created?.zoneId || !created.recordIds?.length) return null;
	return { zoneId: created.zoneId, recordIds: created.recordIds };
}

/** Lê o JSON do banco com tolerância (linha antiga ou adulterada vira `null`, nunca explode). */
export function parsePreviewSetupState(raw: unknown): PreviewSetupState | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1 || typeof r.domain !== "string" || !isDnsProvider(r.dnsProvider) || !isTlsStrategy(r.tls) || !isSetupPlatform(r.platform) || !isPublicIpv4(r.serverIp)) return null;
	const steps = emptySetupSteps();
	const rawSteps = r.steps && typeof r.steps === "object" ? (r.steps as Record<string, unknown>) : {};
	for (const id of SETUP_STEPS) {
		const s = rawSteps[id];
		if (!s || typeof s !== "object") continue;
		const o = s as Record<string, unknown>;
		const status = o.status;
		if (status !== "pending" && status !== "awaiting_user" && status !== "done" && status !== "failed") continue;
		const created = o.created && typeof o.created === "object" ? (o.created as Record<string, unknown>) : undefined;
		steps[id] = {
			status,
			...(o.intent === "creating" ? { intent: "creating" as const } : {}),
			...(typeof o.detail === "string" ? { detail: o.detail.slice(0, 300) } : {}),
			...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
			...(created
				? { created: { ...(typeof created.zoneId === "string" ? { zoneId: created.zoneId } : {}), ...(Array.isArray(created.recordIds) ? { recordIds: created.recordIds.filter((x): x is string => typeof x === "string").slice(0, 10) } : {}) } }
				: {}),
		};
	}
	const approvalSeq = typeof r.approvalSeq === "number" && Number.isInteger(r.approvalSeq) && r.approvalSeq >= 0 ? r.approvalSeq : undefined;
	return { v: 1, domain: r.domain, dnsProvider: r.dnsProvider, tls: r.tls, platform: r.platform, serverIp: r.serverIp, ...(approvalSeq ? { approvalSeq } : {}), steps };
}
