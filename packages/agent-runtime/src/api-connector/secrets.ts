import { openSecrets, sealSecrets } from "../mcp/secret-box.js";

/** Tokens OAuth2 guardados no cofre (nunca em claro fora dele). */
export type ApiOAuthTokens = {
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	/** Epoch ms em que o access token expira (calculado de `expires_in` ao salvar). */
	expires_at?: number;
};

/** Tudo que é segredo de uma conexão de API; vai selado em `secretsEnc`. */
export type ApiConnectorSecrets = {
	/** apiKey / bearer. */
	apiKey?: string;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		tokens?: ApiOAuthTokens;
		/** PKCE do login pendente. */
		codeVerifier?: string;
		/** Início do login pendente (epoch ms): o callback recusa `state` velho. */
		stateCreatedAt?: number;
	};
};

export function sealApiSecrets(secrets: ApiConnectorSecrets): string {
	return sealSecrets<ApiConnectorSecrets>(secrets);
}

export function openApiSecrets(sealed: string | null | undefined): ApiConnectorSecrets {
	return openSecrets<ApiConnectorSecrets>(sealed);
}

/** Valores sensíveis em claro, para redigir de erros e respostas (mínimo 6 caracteres para não apagar texto comum). */
export function apiSecretValues(secrets: ApiConnectorSecrets): string[] {
	const values = [
		secrets.apiKey,
		secrets.oauth?.clientId,
		secrets.oauth?.clientSecret,
		secrets.oauth?.codeVerifier,
		secrets.oauth?.tokens?.access_token,
		secrets.oauth?.tokens?.refresh_token,
	];
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string" || value.length < 6) continue;
		out.push(value, encodeURIComponent(value));
	}
	const basic = secrets.oauth?.clientId && secrets.oauth.clientSecret ? Buffer.from(`${secrets.oauth.clientId}:${secrets.oauth.clientSecret}`).toString("base64") : null;
	if (basic) out.push(basic);
	return [...new Set(out)];
}
