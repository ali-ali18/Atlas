import { loadSandboxConfig, type SandboxRuntimeConfig } from "../config.js";

/**
 * Sessões de desenvolvimento: um container leve por sessão (imagem
 * `docker/dev-sandbox`), separado da VM com desktop. Limites por "tier".
 */

export const DEV_TIER_NAMES = ["small", "medium", "large"] as const;
export type DevTier = (typeof DEV_TIER_NAMES)[number];

export const DEV_TIERS: Record<DevTier, { memoryMb: number; cpus: number }> = {
	// Hosts costumam ter CPU de sobra: o pequeno guarda a memória e ganha 2 vCPUs (DEV_SANDBOX_SMALL_CPUS).
	small: { memoryMb: 1024, cpus: 2 },
	medium: { memoryMb: 2560, cpus: 2 },
	large: { memoryMb: 4096, cpus: 2 },
};

/** O maior tier permitido neste servidor (teto global; nem o ambiente nem a tool passam disso). */
export function minDevTier(a: DevTier, b: DevTier): DevTier {
	return DEV_TIER_NAMES.indexOf(a) <= DEV_TIER_NAMES.indexOf(b) ? a : b;
}

export function isDevTier(value: unknown): value is DevTier {
	return typeof value === "string" && (DEV_TIER_NAMES as readonly string[]).includes(value);
}

/** Limite de CPUs do tier pequeno (DEV_SANDBOX_SMALL_CPUS, padrão 2; aceita decimais como 1.5). */
export function smallTierCpus(raw: string | undefined): number {
	const n = Number.parseFloat(raw ?? "");
	return Number.isFinite(n) && n >= 0.5 && n <= 8 ? n : DEV_TIERS.small.cpus;
}

/** Recursos efetivos de um tier neste servidor. */
export function devTierResources(config: Pick<DevSandboxConfig, "smallCpus">, tier: DevTier): { memoryMb: number; cpus: number } {
	return tier === "small" ? { ...DEV_TIERS.small, cpus: config.smallCpus } : DEV_TIERS[tier];
}

export type DevSandboxConfig = {
	enabled: boolean;
	/** CPUs do tier pequeno. */
	smallCpus: number;
	image: string;
	defaultTier: DevTier;
	/** Teto global de tier (DEV_SANDBOX_MAX_TIER, padrão large). */
	maxTier: DevTier;
	/** Teto global de containers de desenvolvimento rodando ao mesmo tempo. */
	maxConcurrent: number;
	/** Soma máxima dos limites de memória (MB) dos containers rodando. */
	memoryBudgetMb: number;
	/** Memória livre do host (MB) que deve sobrar depois de subir mais um. */
	minFreeMb: number;
	/** Sem atividade por tanto tempo, o container é parado (volume preservado). */
	idleMs: number;
	/** Parada há tanto tempo, o container e o volume são removidos (EXPIRED). */
	expireMs: number;
	pidsLimit: number;
	networkMode: string;
	connectMode: "published" | "network";
	controlHost: string;
	/**
	 * Política de internet das sessões SEM ambiente de repositório: `open` (padrão)
	 * ou `allowlist` (proxy do container com esta lista). Sessões com ambiente
	 * usam a política dele (aplicada em tempo de execução via PUT /egress).
	 */
	egressMode: "open" | "allowlist";
	egressAllowlist: string[];
	/**
	 * Saída aplicada na REDE (container do gateway + rede Docker `internal`). Só funciona com
	 * `connectMode=network` (portas publicadas não existem em redes internas); fora disso cai no
	 * proxy de melhor esforço dentro do container.
	 */
	egressEnforce: boolean;
	/** O operador pediu `network` mas o modo de conexão não permite (gera aviso no log). */
	egressEnforceUnavailable: boolean;
	/** Rede Docker `internal: true` dos containers com internet restrita. */
	internalNetwork: string;
	/** Container do gateway de saída (nome = alias DNS na rede interna). */
	gatewayName: string;
	gatewayImage: string;
	gatewayMemoryMb: number;
	dockerSocketPath: string;
	dockerHost: string;
	/** URL que o container chama quando um job em segundo plano termina (vazio = sem aviso; só a varredura de segurança). */
	callbackUrl: string;
	/** Tentativas de espera pelo /health do container (1s cada). */
	readyAttempts: number;
	/** Cache de dependências por ambiente (DEV_SANDBOX_CACHE=on|off, padrão on). */
	cacheEnabled: boolean;
	/** Teto somado dos caches de ambiente (DEV_SANDBOX_CACHE_MAX_GB, padrão 20); estourou, sai o menos usado. */
	cacheMaxBytes: number;
	/** Cache sem uso por tanto tempo é apagado (padrão 7 dias). */
	cacheMaxAgeMs: number;
};

function positiveNumber(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseFloat(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadDevSandboxConfig(env: NodeJS.ProcessEnv = process.env): DevSandboxConfig {
	const base: SandboxRuntimeConfig = loadSandboxConfig(env);
	const tier = env.DEV_SANDBOX_DEFAULT_TIER?.trim().toLowerCase();
	const connect = (env.DEV_SANDBOX_CONNECT_MODE ?? env.SANDBOX_CONNECT_MODE)?.trim().toLowerCase();
	const enabledRaw = env.DEV_SANDBOX_ENABLED;
	const enforceRaw = env.DEV_SANDBOX_EGRESS_ENFORCE?.trim().toLowerCase();
	const connectMode = connect === "network" ? "network" : "published";
	const apiPort = positiveInt(env.PORT, 3001);
	// Rede compartilhada: a API é o serviço `api`; portas publicadas (Docker Desktop): o container alcança o host.
	const callbackBase = connectMode === "network" ? `http://api:${apiPort}` : `http://host.docker.internal:${apiPort}`;
	const callbackRaw = env.DEV_SANDBOX_CALLBACK_URL?.trim();
	const image = env.DEV_SANDBOX_IMAGE?.trim() || "atlas-dev-sandbox:latest";
	return {
		// Desligado por padrão: precisa da imagem construída e de DEV_SANDBOX_ENABLED=true.
		enabled: base.enabled && (enabledRaw === "1" || enabledRaw === "true"),
		image,
		smallCpus: smallTierCpus(env.DEV_SANDBOX_SMALL_CPUS),
		defaultTier: isDevTier(tier) ? tier : "small",
		maxTier: isDevTier(env.DEV_SANDBOX_MAX_TIER?.trim().toLowerCase()) ? (env.DEV_SANDBOX_MAX_TIER!.trim().toLowerCase() as DevTier) : "large",
		maxConcurrent: positiveInt(env.DEV_SANDBOX_MAX_CONCURRENT, 2),
		memoryBudgetMb: positiveInt(env.DEV_SANDBOX_MEMORY_BUDGET_MB, 4096),
		minFreeMb: positiveInt(env.DEV_SANDBOX_MIN_FREE_MB, 512),
		idleMs: positiveInt(env.DEV_SANDBOX_IDLE_MS, 10 * 60_000),
		expireMs: positiveInt(env.DEV_SANDBOX_EXPIRE_MS, 7 * 24 * 60 * 60_000),
		pidsLimit: positiveInt(env.DEV_SANDBOX_PIDS_LIMIT, 512),
		networkMode: env.DEV_SANDBOX_NETWORK_MODE?.trim() || base.networkMode,
		connectMode,
		controlHost: env.DEV_SANDBOX_CONTROL_HOST?.trim() || base.controlHost,
		egressMode: env.DEV_SANDBOX_EGRESS_MODE?.trim().toLowerCase() === "allowlist" ? "allowlist" : "open",
		egressAllowlist: (env.DEV_SANDBOX_EGRESS_ALLOWLIST ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
		// auto (padrão): aplica na rede quando o worker alcança os containers pela rede (connectMode=network).
		egressEnforce: enforceRaw !== "off" && connectMode === "network",
		egressEnforceUnavailable: enforceRaw === "network" && connectMode !== "network",
		internalNetwork: env.DEV_SANDBOX_INTERNAL_NETWORK?.trim() || "dev-egress-internal",
		gatewayName: env.DEV_SANDBOX_GATEWAY_NAME?.trim() || "dev-egress-gateway",
		gatewayImage: env.DEV_SANDBOX_GATEWAY_IMAGE?.trim() || image,
		gatewayMemoryMb: positiveInt(env.DEV_SANDBOX_GATEWAY_MEMORY_MB, 128),
		dockerSocketPath: base.dockerSocketPath,
		dockerHost: base.dockerHost,
		callbackUrl: callbackRaw === "off" ? "" : callbackRaw || `${callbackBase}/v1/internal/dev-jobs/callback`,
		readyAttempts: positiveInt(env.DEV_SANDBOX_READY_ATTEMPTS, 30),
		cacheEnabled: !["off", "0", "false", "no"].includes(env.DEV_SANDBOX_CACHE?.trim().toLowerCase() ?? ""),
		cacheMaxBytes: Math.floor(positiveNumber(env.DEV_SANDBOX_CACHE_MAX_GB, 20) * 1024 * 1024 * 1024),
		cacheMaxAgeMs: Math.floor(positiveNumber(env.DEV_SANDBOX_CACHE_MAX_AGE_DAYS, 7) * 24 * 60 * 60_000),
	};
}
