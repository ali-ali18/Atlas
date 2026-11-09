// Forma do que a caixa de segredos guarda por conector MCP (`McpConnection.secretsEnc`). Só tipos: o legado
// (agent-runtime) e o cliente Google compartilham a mesma definição.

export type McpOAuthSecrets = {
	tokens?: Record<string, unknown>;
	/** Quando `tokens` foi salvo (epoch ms) — base para saber se `expires_in` já passou. */
	tokensSavedAt?: number;
	clientInformation?: Record<string, unknown>;
	codeVerifier?: string;
	/** URL de autorização pendente (devolvida à UI para abrir o popup). */
	authorizationUrl?: string;
	/** Início do login pendente (epoch ms): o callback recusa `state` velho. */
	stateCreatedAt?: number;
};

export type McpConnectorSecrets = {
	apiKey?: string;
	/** URL real quando a credencial vai na própria URL (a coluna guarda a versão pública). */
	url?: string;
	headers?: Record<string, string>;
	/** Composio: apps sem login ativados (viram `no_auth_apps` do servidor MCP). */
	noAuthApps?: string[];
	oauth?: McpOAuthSecrets;
};
