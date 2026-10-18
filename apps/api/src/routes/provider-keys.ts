import { Hono } from "hono";
import { ApiKeyServiceError, apiKeyService, normalizeApiKey, type ApiKeyService } from "@workspace/agent-runtime";
import { ProviderApiError, fetchAnthropicModels, fetchOpencodeGoModels } from "@workspace/llm";
import { API_KEY_PROVIDERS, isApiKeyProvider, type ApiKeyProvider, type ApiKeyProviderStatus, type ProviderModelsResponse } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { apiKeyModelCatalog } from "../providers/model-catalog.js";

export type ProviderKeyDeps = {
	service: Pick<ApiKeyService, "status" | "getKey" | "save" | "setModelCount" | "markError" | "remove" | "vaultReady">;
	catalog: Pick<typeof apiKeyModelCatalog, "list" | "clear">;
	/** Testa uma chave contra o provedor e devolve a quantidade de modelos. Injetável em teste. */
	testKey: (provider: ApiKeyProvider, apiKey: string) => Promise<number>;
};

export async function testProviderKey(provider: ApiKeyProvider, apiKey: string): Promise<number> {
	if (provider === "anthropic") return (await fetchAnthropicModels(apiKey)).length;
	return (await fetchOpencodeGoModels(apiKey)).models.length;
}

/** Mensagens fixas: nada do upstream (nem a chave) volta ao navegador. */
function failure(error: unknown): { status: 400 | 502 | 503; error: string; code: string } {
	if (error instanceof ApiKeyServiceError)
		return { status: error.status === 503 ? 503 : 400, error: error.message, code: error.code };
	if (error instanceof ProviderApiError) {
		if (error.code === "auth_failed") return { status: 400, error: "Chave recusada pelo provedor. Confira e tente de novo.", code: "auth_failed" };
		if (error.code === "limit_exceeded" || error.code === "rate_limited") return { status: 400, error: "Chave válida, mas o provedor limitou o uso agora.", code: error.code };
		return { status: 502, error: "Não foi possível falar com o provedor. Tente novamente.", code: error.code };
	}
	return { status: 502, error: "Não foi possível concluir a operação. Tente novamente.", code: "upstream_error" };
}

/**
 * Chaves de API do próprio usuário (Anthropic, OpenCode Go): colar, testar, remover.
 * A chave é write-only: entra no PUT, vai ao cofre cifrado e nunca sai.
 */
export function createProviderKeyRoutes(deps: ProviderKeyDeps = { service: apiKeyService, catalog: apiKeyModelCatalog, testKey: testProviderKey }) {
	const app = new Hono<AuthEnv>();
	const userOf = (c: { get(key: "session"): Parameters<typeof scopeFor>[0] }) => scopeFor(c.get("session")).userId;

	app.get("/v1/provider-keys", async (c) => {
		try {
			const userId = userOf(c);
			const providers: ApiKeyProviderStatus[] = await Promise.all(API_KEY_PROVIDERS.map((provider) => deps.service.status(userId, provider)));
			return c.json({ providers, vaultReady: deps.service.vaultReady() });
		} catch {
			return c.json({ error: "Não foi possível carregar os provedores" }, 503);
		}
	});

	app.put("/v1/provider-keys/:provider", async (c) => {
		const provider = c.req.param("provider");
		if (!isApiKeyProvider(provider)) return c.json({ error: "Não encontrado" }, 404);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Corpo inválido" }, 400);
		}
		const apiKey = normalizeApiKey((body as { apiKey?: unknown } | null)?.apiKey);
		if (!apiKey) return c.json({ error: "Informe uma chave de API válida" }, 400);
		if (!deps.service.vaultReady()) return c.json({ error: "Defina CONNECTOR_ENCRYPTION_KEY no .env da API e do worker", code: "vault_unavailable" }, 503);
		try {
			const userId = userOf(c);
			const modelCount = await deps.testKey(provider, apiKey);
			await deps.service.save(userId, provider, apiKey, modelCount);
			deps.catalog.clear(userId, provider);
			return c.json({ status: await deps.service.status(userId, provider) });
		} catch (error) {
			const safe = failure(error);
			return c.json({ error: safe.error, code: safe.code }, safe.status);
		}
	});

	/** Reteste da chave já guardada: atualiza contagem e status. */
	app.post("/v1/provider-keys/:provider/test", async (c) => {
		const provider = c.req.param("provider");
		if (!isApiKeyProvider(provider)) return c.json({ error: "Não encontrado" }, 404);
		try {
			const userId = userOf(c);
			const key = await deps.service.getKey(userId, provider);
			if (!key) return c.json({ error: "Provedor não conectado", code: "not_connected" }, 400);
			try {
				const count = await deps.testKey(provider, key);
				await deps.service.setModelCount(userId, provider, count);
			} catch (error) {
				if (error instanceof ProviderApiError && error.code === "auth_failed") await deps.service.markError(userId, provider, "auth_failed");
				throw error;
			}
			deps.catalog.clear(userId, provider);
			return c.json({ status: await deps.service.status(userId, provider) });
		} catch (error) {
			const safe = failure(error);
			return c.json({ error: safe.error, code: safe.code }, safe.status);
		}
	});

	app.delete("/v1/provider-keys/:provider", async (c) => {
		const provider = c.req.param("provider");
		if (!isApiKeyProvider(provider)) return c.json({ error: "Não encontrado" }, 404);
		try {
			const userId = userOf(c);
			await deps.service.remove(userId, provider);
			deps.catalog.clear(userId, provider);
			return c.json({ ok: true });
		} catch {
			return c.json({ error: "Não foi possível remover a chave" }, 503);
		}
	});

	app.get("/v1/provider-keys/:provider/models", async (c) => {
		const provider = c.req.param("provider");
		if (!isApiKeyProvider(provider)) return c.json({ error: "Não encontrado" }, 404);
		try {
			const result = await deps.catalog.list(userOf(c), provider);
			const body: ProviderModelsResponse = { models: result.models, status: result.connected ? "connected" : "disconnected", catalogAvailable: result.catalogAvailable };
			return c.json(body);
		} catch {
			return c.json({ error: "Não foi possível carregar os modelos" }, 503);
		}
	});

	return app;
}
