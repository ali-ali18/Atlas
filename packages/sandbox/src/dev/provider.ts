import type { AdmissionDenied } from "./admission.js";
import type { DevTier } from "./config.js";

/**
 * Abstração do ambiente de execução de uma sessão de desenvolvimento. Hoje só
 * existe o provedor Docker; um provedor remoto (VM/serviço) implementa a mesma
 * interface e o resto (tools, reaper) não muda.
 */

export type DevEndpoint = { baseUrl: string; token: string };

export type DevEnsureInput = {
	sessionId: string;
	userId: string;
	tier: DevTier;
	/** Política inicial de internet (sessão nova); depois muda via `DevClient.setEgress`. */
	egress?: { mode: "full" | "allowlist" | "off"; allowlist: string[] };
	/** Repositório (owner/nome) cujo cache de dependências é montado em /envcache (sessão nova). */
	envCacheRepo?: string;
};

export type DevEnsureResult =
	| { status: "running"; endpoint: DevEndpoint; containerId: string; resumed: boolean }
	/** Sem recursos agora: nada foi iniciado; tente de novo mais tarde. */
	| { status: "queued"; denied: AdmissionDenied };

export type DevContainerInfo = {
	state: "running" | "stopped" | "missing";
	containerId?: string;
};

export interface DevSandboxProvider {
	/** Cria o ambiente (ou religa o parado, com o mesmo volume), respeitando a admissão. */
	ensureRunning(input: DevEnsureInput): Promise<DevEnsureResult>;
	/**
	 * Muda a política de internet de um ambiente já rodando (rede + gateway). Opcional: provedores
	 * sem isolamento de rede não implementam.
	 */
	setEgress?(sessionId: string, policy: { mode: "full" | "allowlist" | "off"; allowlist: string[] }): Promise<void>;
	/** Para o ambiente preservando o workspace. */
	stop(sessionId: string): Promise<void>;
	/** Remove o ambiente; `removeVolume` apaga também o workspace (irreversível). */
	destroy(sessionId: string, options?: { removeVolume?: boolean }): Promise<void>;
	inspect(sessionId: string): Promise<DevContainerInfo>;
	/** Endpoint de um ambiente já rodando (ou `null`). */
	endpoint(sessionId: string): Promise<DevEndpoint | null>;
	/** Apaga o cache de dependências de um ambiente (usuário + repo). Devolve se havia o que apagar. */
	clearEnvCache?(userId: string, repo: string): Promise<boolean>;
	/** Expira caches sem uso e aplica o teto de tamanho (LRU). */
	sweepEnvCaches?(): Promise<{ evicted: Array<{ name: string; reason: "expired" | "over-limit" }>; totalBytes: number }>;
	/** Comandos ainda em execução dentro do ambiente (0 se indisponível). */
	runningJobs(sessionId: string): Promise<number>;
}
