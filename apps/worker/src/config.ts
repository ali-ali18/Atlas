const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_SUMMARIZER_MODEL = "openai/gpt-6-luna";
const DEFAULT_AGENT_RUN_CONCURRENCY = 4;

export type WorkerConfig = {
	redisUrl: string;
	openRouterApiKey: string | undefined;
	openRouterModel: string;
	/**
	 * Valores do env no boot. O run NÃO usa estes campos: lê a configuração da conta
	 * por run (`run-config.ts`, usuário > env > padrão). Ficam para quem só tem o boot.
	 */
	jevMcpMode?: "off" | "shadow" | "gate";
	/** F11 — decisões com Jev, uma chave por item (off | shadow | on). Padrão: off. */
	jevModes?: Partial<Record<"intent" | "tools" | "verify" | "blockpage" | "delegate" | "stuck", "off" | "shadow" | "on">>;
	/** Modelo do resumidor (Fase 1). Barato por padrão; nunca precisa ser o do run. */
	summarizerModel: string;
	maintenanceModel?: string;
	agentRunConcurrency: number;
	/**
	 * Parte B — pesquisa web (provedor plugável: firecrawl | tavily | brave | serper).
	 * Só leitura de env; nunca logar (credenciais).
	 */
	searchProvider?: string;
	/** SEARCH_API_KEY (precedência) — chave do provedor de busca. Nunca logar. */
	searchApiKey?: string;
	/** FIRECRAWL_API_KEY — busca (quando provider=firecrawl) + extração. Nunca logar. */
	firecrawlApiKey?: string;
	/**
	 * Gancho Parte C (sheets): JSON inline ou path do arquivo de credencial.
	 * Lê GOOGLE_SERVICE_ACCOUNT_JSON || GOOGLE_SHEETS_CREDENTIALS. Nunca logar.
	 * (sheets-tools.ts usa service account por campos: ver sheetsClientEmail/Key.)
	 */
	googleServiceAccount?: string;
	/** GOOGLE_SHEETS_CLIENT_EMAIL — service account (sheets_read/append). Nunca logar. */
	sheetsClientEmail?: string;
	/** GOOGLE_SHEETS_PRIVATE_KEY — service account (sheets_read/append). Nunca logar. */
	sheetsPrivateKey?: string;
};

export function parseJevModes(env: NodeJS.ProcessEnv): NonNullable<WorkerConfig["jevModes"]> {
	const read = (raw: string | undefined): "off" | "shadow" | "on" => {
		const value = raw?.trim().toLowerCase();
		return value === "shadow" || value === "on" ? value : "off";
	};
	return {
		intent: read(env.JEV_INTENT_MODE),
		tools: read(env.JEV_TOOLS_MODE),
		verify: read(env.JEV_VERIFY_MODE),
		blockpage: read(env.JEV_BLOCKPAGE_MODE),
		delegate: read(env.JEV_DELEGATE_MODE),
		stuck: read(env.JEV_STUCK_MODE),
	};
}

export function parseAgentRunConcurrency(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_AGENT_RUN_CONCURRENCY;
	return Math.min(32, parsed);
}

export function loadWorkerConfig(): WorkerConfig {
	const jevMode = process.env.JEV_MCP_MODE?.trim();
	return {
		redisUrl: process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379",
		openRouterApiKey: process.env.OPENROUTER_API_KEY,
		openRouterModel:
			process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
		jevMcpMode: jevMode === "shadow" || jevMode === "gate" ? jevMode : "off",
		jevModes: parseJevModes(process.env),
		summarizerModel:
			process.env.SUMMARIZER_MODEL?.trim() || DEFAULT_SUMMARIZER_MODEL,
		maintenanceModel: process.env.ATLAS_MAINTENANCE_MODEL?.trim() || undefined,
		agentRunConcurrency: parseAgentRunConcurrency(
			process.env.AGENT_RUN_CONCURRENCY,
		),
		searchProvider:
			process.env.SEARCH_PROVIDER?.trim() || undefined,
		// Credenciais: só leitura de env, nunca logar.
		searchApiKey: process.env.SEARCH_API_KEY || undefined,
		firecrawlApiKey: process.env.FIRECRAWL_API_KEY || undefined,
		googleServiceAccount:
			process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
			process.env.GOOGLE_SHEETS_CREDENTIALS ||
			undefined,
		sheetsClientEmail: process.env.GOOGLE_SHEETS_CLIENT_EMAIL || undefined,
		sheetsPrivateKey: process.env.GOOGLE_SHEETS_PRIVATE_KEY || undefined,
	};
}
