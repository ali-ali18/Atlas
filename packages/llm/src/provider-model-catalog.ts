import { parseChatgptModels, visibleProviderModels, type ProviderModel, type ProviderModelsResponse, type ProviderStatus } from "@workspace/shared";
import { createModelCatalogCache } from "./model-catalog-cache.js";
import { CHATGPT_CODEX_BASE_URL, chatgptCodexHeaders } from "./responses/stream.js";

/** `client_version` exigido pelo catálogo do backend do plano. */
const CODEX_CLIENT_VERSION = "0.100.0";

/** Cache por dono e registro da conta; nunca expõe ou conserva tokens no catálogo. */
export function createChatgptModelCatalog(deps: {
	status(userId: string): Promise<ProviderStatus>;
	getAccessToken(userId: string, options?: { force?: boolean; previousAccessToken?: string }): Promise<string>;
	/** Presente = catálogo do backend do plano (login por código). */
	getAccountId?(userId: string): Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
}) {
	const caches = new Map<string, { revision: string | null; cache: ReturnType<typeof createModelCatalogCache<ProviderModel[]>> }>();
	const fetcher = deps.fetch ?? fetch;
	async function all(userId: string): Promise<{ models: ProviderModel[] | null; state: ProviderStatus }> {
		const state = await deps.status(userId);
		if (state.status !== "connected") { caches.delete(userId); return { models: [], state }; }
		let entry = caches.get(userId);
		if (!entry || entry.revision !== state.updatedAt) {
			entry = { revision: state.updatedAt, cache: createModelCatalogCache(async () => {
				let token = await deps.getAccessToken(userId);
				const accountId = (await deps.getAccountId?.(userId)) ?? null;
				const send = () => fetcher(accountId ? `${CHATGPT_CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}` : "https://api.openai.com/v1/models", { headers: { ...(accountId ? chatgptCodexHeaders(token, accountId) : { Authorization: `Bearer ${token}` }), Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
				let requestState = await deps.status(userId);
				if (requestState.status !== "connected") throw new Error("Conexão ChatGPT alterada");
				let response = await send();
				if (response.status === 401) { token = await deps.getAccessToken(userId, { force: true, previousAccessToken: token }); requestState = await deps.status(userId); response = await send(); }
				if (!response.ok) throw new Error("Catálogo ChatGPT indisponível");
				const json: unknown = await response.json();
				const current = await deps.status(userId);
				if (current.status !== "connected" || current.updatedAt !== requestState.updatedAt) throw new Error("Conexão ChatGPT alterada");
				return parseChatgptModels(json);
			}, { now: deps.now }) };
			caches.set(userId, entry);
		}
		const models = await entry.cache.get();
		const current = await deps.status(userId);
		if (current.status !== "connected") { caches.delete(userId); return { models: [], state: current }; }
		if (current.updatedAt !== state.updatedAt) { caches.delete(userId); return { models: null, state: current }; }
		return { models, state: current };
	}
	return {
		async list(userId: string, selected?: string): Promise<ProviderModelsResponse> {
			const result = await all(userId);
			return { models: visibleProviderModels(result.models ?? [], selected), status: result.state.status, catalogAvailable: result.models !== null };
		},
		async isKnown(userId: string, id: string): Promise<boolean | null> {
			const result = await all(userId);
			return result.state.status !== "connected" ? false : result.models?.some((model) => model.id === id) ?? null;
		},
		async find(userId: string, id: string): Promise<ProviderModel | undefined> {
			return (await all(userId)).models?.find((model) => model.id === id);
		},
		clear(userId: string) { caches.delete(userId); },
	};
}
