import { Hono } from "hono";
import {
	AccountConfigTooLargeError,
	getAccountConfig,
	getUserSettings,
	patchAccountConfig,
	updateUserSettings,
} from "@workspace/db";
import {
	parseModelRef,
	resolveEffectiveConfig,
	validateAccountConfigPatch,
	type AccountConfigError,
	type AccountConfigPatch,
	type AccountSettingsResponse,
	type UpdateUserSettingsInput,
} from "@workspace/shared";
import { isOwnerEmail } from "../auth.js";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { validateProviderModel, type ModelValidation } from "../providers/model-catalog.js";
import { stopSiwcLoopback } from "../providers/siwc-loopback.js";
import { isKnownModelId } from "./models.js";

type ParsedBody =
	| { ok: true; settings: UpdateUserSettingsInput; config?: AccountConfigPatch }
	| { ok: false; error: string; fields?: AccountConfigError[] };

function parseUpdateSettings(body: unknown): ParsedBody {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "Corpo inválido: esperado { sandboxAutoStart?, config? }" };
	}
	// Chaves de topo desconhecidas (inclusive `userId`) são ignoradas: o escopo vem da sessão.
	const raw = body as Record<string, unknown>;
	const settings: UpdateUserSettingsInput = {};
	if ("sandboxAutoStart" in raw) {
		if (typeof raw.sandboxAutoStart !== "boolean") {
			return { ok: false, error: "sandboxAutoStart deve ser verdadeiro ou falso" };
		}
		settings.sandboxAutoStart = raw.sandboxAutoStart;
	}
	if (raw.config === undefined) return { ok: true, settings };
	const validated = validateAccountConfigPatch(raw.config);
	if (!validated.ok) return { ok: false, error: "Configuração inválida", fields: validated.errors };
	return { ok: true, settings, config: validated.patch };
}

/** Ids de modelo citados no patch, com o caminho para a mensagem de erro. */
function modelsInPatch(patch: AccountConfigPatch): Array<{ path: string; id: string }> {
	const models = patch.models;
	if (!models) return [];
	const found: Array<{ path: string; id: string }> = [];
	for (const key of ["default", "maintenance", "reviewer", "vision", "image", "coding"] as const) {
		const id = models[key];
		if (typeof id === "string") found.push({ path: `models.${key}`, id });
	}
	for (const id of models.fallbacks ?? []) found.push({ path: "models.fallbacks", id });
	return found;
}

export type SettingsRouteDeps = {
	env?: NodeJS.ProcessEnv;
	isKnownModel?: (id: string) => Promise<boolean | null>;
	validateModel?: (userId: string, model: string) => Promise<ModelValidation>;
	/** Fecha o listener do callback SIWC quando o plano ChatGPT fica desligado. */
	stopLoopback?: () => Promise<void>;
};

/** chatgpt/*, anthropic-direct/* e opencode-go/*: validados pela conexão, não pelo OpenRouter. */
function isDirectProviderModel(id: string): boolean {
	try {
		return parseModelRef(id).provider !== "openrouter";
	} catch {
		return id.startsWith("chatgpt/");
	}
}

export function createSettingsRoutes(deps: SettingsRouteDeps = {}) {
	const app = new Hono<AuthEnv>();
	const env = deps.env ?? process.env;
	const isKnownModel = deps.isKnownModel ?? isKnownModelId;
	const validateModel = deps.validateModel ?? validateProviderModel;
	const stopLoopback = deps.stopLoopback ?? stopSiwcLoopback;

	/** Tudo lido pelo `userId` da sessão; nenhum segredo entra na resposta. */
	async function buildResponse(userId: string, email: string): Promise<AccountSettingsResponse> {
		const [settings, config] = await Promise.all([getUserSettings(userId), getAccountConfig(userId)]);
		return {
			settings,
			config,
			effective: resolveEffectiveConfig({
				user: { config, sandboxAutoStart: settings.sandboxAutoStart },
				env,
			}),
			capabilities: {
				openrouterKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
				isOwner: isOwnerEmail(email),
			},
		};
	}

	/** Modelo desconhecido ou provedor indisponível viram erro por campo; catálogo fora do ar aceita. */
	async function modelErrors(userId: string, patch: AccountConfigPatch): Promise<AccountConfigError[]> {
		const errors: AccountConfigError[] = [];
		for (const { path, id } of modelsInPatch(patch)) {
			if (isDirectProviderModel(id)) {
				// Só `models.default` aceita chatgpt/* (o contrato recusa nos demais).
				const validation = await validateModel(userId, id);
				if ("error" in validation) errors.push({ path, message: validation.error });
				continue;
			}
			if ((await isKnownModel(id)) === false) {
				errors.push({ path, message: "Modelo desconhecido no OpenRouter." });
			}
		}
		return errors;
	}

	app.get("/v1/settings", async (c) => {
		try {
			const session = c.get("session");
			const { userId } = scopeFor(session);
			return c.json(await buildResponse(userId, session.user.email));
		} catch (error) {
			console.error("get settings failed", error);
			return c.json({ error: "Failed to get settings" }, 503);
		}
	});

	app.patch("/v1/settings", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const parsed = parseUpdateSettings(json);
		if (!parsed.ok) {
			return c.json({ error: parsed.error, ...(parsed.fields ? { fields: parsed.fields } : {}) }, 400);
		}

		try {
			const session = c.get("session");
			const { userId } = scopeFor(session);

			if (parsed.config) {
				// O plano ChatGPT é do dono; para os demais o recurso não existe (404).
				if (parsed.config.providers !== undefined && !isOwnerEmail(session.user.email)) {
					return c.json({ error: "Não encontrado" }, 404);
				}
				const fields = await modelErrors(userId, parsed.config);
				if (fields.length > 0) return c.json({ error: "Configuração inválida", fields }, 400);
			}

			if (parsed.settings.sandboxAutoStart !== undefined) {
				await updateUserSettings(parsed.settings, userId);
			}
			if (parsed.config) await patchAccountConfig(userId, parsed.config);
			const response = await buildResponse(userId, session.user.email);
			// Plano desligado (pelo usuário ou ao voltar a herdar um env desligado): a porta do
			// callback não precisa ficar aberta. Os tokens ficam no cofre; o próximo "Conectar" sobe de novo.
			if (parsed.config?.providers !== undefined && !response.effective.providers.chatgptEnabled.value) {
				await stopLoopback().catch(() => undefined);
			}
			return c.json(response);
		} catch (error) {
			if (error instanceof AccountConfigTooLargeError) {
				return c.json({ error: "Configuração inválida", fields: [{ path: "config", message: error.message }] }, 400);
			}
			console.error("update settings failed", error);
			return c.json({ error: "Failed to update settings" }, 503);
		}
	});

	return app;
}
