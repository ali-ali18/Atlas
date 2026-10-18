import { Hono } from "hono";
import { createDockerDevProvider, loadDevSandboxConfig } from "@workspace/sandbox";
import {
	countDevEnvironments,
	createDevEnvironment,
	deleteDevEnvironment,
	getDevEnvironment,
	getDevApprovalDefault,
	getDevEnvironmentByRepo,
	listDevEnvironments,
	setDevApprovalDefault,
	getDevVerifierEnabled,
	setDevVerifierEnabled,
	updateDevEnvironment,
	type DevEnvironmentRecord,
} from "@workspace/db";
import { getGithubToken, isSecretBoxConfigured, openSecrets, sealSecrets } from "@workspace/agent-runtime";
import { probeRepo, type ProbeResult } from "./dev-env-probe.js";
import {
	DEFAULT_COMMAND_ALLOWLIST,
	isDevApprovalMode,
	DEV_ENV_MAX_SECRETS,
	parseDevEnvBody,
	validateSecretName,
	validateSecretValue,
	detectDevEnvironment,
	isMaskedSecretValue,
} from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

type Deps = {
	list: typeof listDevEnvironments;
	get: typeof getDevEnvironment;
	getByRepo: typeof getDevEnvironmentByRepo;
	count: typeof countDevEnvironments;
	create: typeof createDevEnvironment;
	update: typeof updateDevEnvironment;
	remove: typeof deleteDevEnvironment;
	getApprovalDefault: typeof getDevApprovalDefault;
	setApprovalDefault: typeof setDevApprovalDefault;
	getVerifier: typeof getDevVerifierEnabled;
	setVerifier: typeof setDevVerifierEnabled;
	secretBoxReady: () => boolean;
	/** Sessões de código ligadas neste servidor (DEV_SANDBOX_ENABLED); a UI mostra "Testar uma PR" só com elas. */
	devSessionsEnabled: () => boolean;
	seal: (secrets: Record<string, string>) => string;
	open: (sealed: string | null) => Record<string, string>;
	/** Apaga o cache de dependências do ambiente (volume do usuário+repo). Falso se não havia cache ou o recurso está desligado. */
	clearCache: (userId: string, repo: string) => Promise<boolean>;
	/** Lê a raiz do repositório pelo GitHub (token do app/OAuth do usuário); somente leitura. */
	probe: (userId: string, repo: string) => Promise<ProbeResult>;
};

const defaultDeps: Deps = {
	list: listDevEnvironments,
	get: getDevEnvironment,
	getByRepo: getDevEnvironmentByRepo,
	count: countDevEnvironments,
	create: createDevEnvironment,
	update: updateDevEnvironment,
	remove: deleteDevEnvironment,
	getApprovalDefault: getDevApprovalDefault,
	setApprovalDefault: setDevApprovalDefault,
	getVerifier: getDevVerifierEnabled,
	setVerifier: setDevVerifierEnabled,
	secretBoxReady: () => isSecretBoxConfigured(),
	devSessionsEnabled: () => loadDevSandboxConfig().enabled,
	seal: (secrets) => sealSecrets(secrets),
	open: (sealed) => openSecrets<Record<string, string>>(sealed),
	clearCache: async (userId, repo) => {
		const config = loadDevSandboxConfig();
		if (!config.enabled || !config.cacheEnabled) return false;
		return (await createDockerDevProvider(config).clearEnvCache?.(userId, repo)) ?? false;
	},
	probe: async (userId, repo) => {
		const token = await getGithubToken(userId, { repo }).catch(() => null);
		if (!token || "error" in token) return { reason: "no_access" };
		return probeRepo(token.token, repo);
	},
};

export const MAX_DEV_ENVIRONMENTS_PER_USER = 50;
const SECRET_BOX_ERROR = "Defina CONNECTOR_ENCRYPTION_KEY (32 bytes em base64) no .env da API e do worker para guardar segredos";

/** Nomes dos segredos ("definido"); os valores nunca saem do servidor. */
function secretNames(sealed: string | null, open: Deps["open"]): { names: string[]; unreadable: boolean } {
	if (!sealed) return { names: [], unreadable: false };
	try {
		return { names: Object.keys(open(sealed)).sort(), unreadable: false };
	} catch {
		return { names: [], unreadable: true };
	}
}

export function toDevEnvironmentView(row: DevEnvironmentRecord, open: Deps["open"] = defaultDeps.open) {
	const { names, unreadable } = secretNames(row.sealedSecrets, open);
	return {
		id: row.id,
		repo: row.repo,
		installCommand: row.installCommand,
		startCommand: row.startCommand,
		testCommand: row.testCommand,
		tier: row.tier,
		network: row.network,
		allowlist: row.allowlist,
		approvalMode: row.approvalMode,
		commandAllowlist: row.commandAllowlist,
		source: row.source,
		userEditedFields: row.userEditedFields,
		secrets: names.map((name) => ({ name, set: true as const })),
		...(unreadable ? { secretsUnreadable: true } : {}),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Ambientes de código por repositório (Configurações > Conexões). Dono vem da
 * sessão de login; recurso alheio responde 404. Segredos são write-only: a API
 * devolve só os nomes.
 */
export function createDevEnvironmentRoutes(deps: Deps = defaultDeps) {
	const app = new Hono<AuthEnv>();

	app.get("/v1/dev-environments", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const rows = await deps.list(userId);
			const defaultApprovalMode = await deps.getApprovalDefault(userId).catch(() => null);
			const verifierEnabled = await deps.getVerifier(userId).catch(() => true);
			return c.json({ environments: rows.map((row) => toDevEnvironmentView(row, deps.open)), secretsAvailable: deps.secretBoxReady(), defaultApprovalMode, verifierEnabled, devSessionsEnabled: deps.devSessionsEnabled() });
		} catch (error) {
			console.error("list dev environments failed", error);
			return c.json({ error: "Failed to list environments" }, 503);
		}
	});

	/** Sugestões de ambiente a partir dos arquivos do repositório (nada é salvo). */
	app.get("/v1/dev-environments/detect", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const result = await deps.probe(userId, c.req.query("repo") ?? "");
			if ("reason" in result) return c.json({ detected: false, reason: result.reason });
			return c.json(detectDevEnvironment(result.probe));
		} catch (error) {
			console.error("detect dev environment failed", error instanceof Error ? error.message : "unknown");
			return c.json({ detected: false, reason: "unavailable" });
		}
	});

	/** Padrão da conta para aprovação de comandos (ambientes sem modo próprio herdam). */
	app.put("/v1/dev-environments-defaults", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const body = (await c.req.json().catch(() => null)) as { approvalMode?: unknown; verifier?: unknown } | null;
			const hasVerifier = body !== null && "verifier" in body;
			if (hasVerifier && typeof body.verifier !== "boolean") return c.json({ error: "Verificador inválido" }, 400);
			// Só o Verificador no corpo: o modo de aprovação fica como está.
			const touchesMode = !hasVerifier || "approvalMode" in body;
			const mode = touchesMode ? (body?.approvalMode ?? null) : await deps.getApprovalDefault(userId);
			if (mode !== null && !isDevApprovalMode(mode)) return c.json({ error: "Aprovação de comandos inválida" }, 400);
			if (touchesMode) await deps.setApprovalDefault(userId, mode);
			if (hasVerifier) await deps.setVerifier(userId, body.verifier as boolean);
			return c.json({ defaultApprovalMode: mode, verifierEnabled: await deps.getVerifier(userId) });
		} catch (error) {
			console.error("set dev approval default failed", error);
			return c.json({ error: "Failed to save default" }, 503);
		}
	});

	app.post("/v1/dev-environments", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const parsed = parseDevEnvBody(await c.req.json().catch(() => null), { partial: false });
			if (parsed.error !== undefined) return c.json({ error: parsed.error }, 400);
			const input = parsed.value;
			if ((await deps.count(userId)) >= MAX_DEV_ENVIRONMENTS_PER_USER) {
				return c.json({ error: `Limite de ${MAX_DEV_ENVIRONMENTS_PER_USER} ambientes` }, 400);
			}
			if (await deps.getByRepo(userId, input.repo!)) return c.json({ error: "Já existe um ambiente para este repositório" }, 409);
			const row = await deps.create(userId, {
				repo: input.repo!,
				installCommand: input.installCommand ?? null,
				startCommand: input.startCommand ?? null,
				testCommand: input.testCommand ?? null,
				tier: input.tier ?? "small",
				network: input.network ?? "allowlist",
				allowlist: input.allowlist ?? [],
				approvalMode: input.approvalMode ?? null,
				commandAllowlist: input.commandAllowlist ?? [...DEFAULT_COMMAND_ALLOWLIST],
			});
			return c.json(toDevEnvironmentView(row, deps.open), 201);
		} catch (error) {
			if (isUniqueViolation(error)) return c.json({ error: "Já existe um ambiente para este repositório" }, 409);
			console.error("create dev environment failed", error);
			return c.json({ error: "Failed to create environment" }, 503);
		}
	});

	app.patch("/v1/dev-environments/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const parsed = parseDevEnvBody(await c.req.json().catch(() => null), { partial: true });
			if (parsed.error !== undefined) return c.json({ error: parsed.error }, 400);
			const id = c.req.param("id");
			const current = await deps.get(id, userId);
			if (!current) return c.json({ error: "Environment not found" }, 404);
			if (parsed.value.repo && parsed.value.repo !== current.repo) {
				const clash = await deps.getByRepo(userId, parsed.value.repo);
				if (clash) return c.json({ error: "Já existe um ambiente para este repositório" }, 409);
			}
			// Campos que o usuário mudou ficam marcados: o agente (dev_environment_update) não os sobrescreve.
			const edited = new Set(current.userEditedFields ?? []);
			const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
			for (const field of ["installCommand", "startCommand", "testCommand", "tier", "network", "allowlist", "approvalMode", "commandAllowlist"] as const) {
				if (field in parsed.value && !same(parsed.value[field], current[field])) edited.add(field);
			}
			const row = await deps.update(id, userId, { ...parsed.value, userEditedFields: [...edited] });
			if (!row) return c.json({ error: "Environment not found" }, 404);
			return c.json(toDevEnvironmentView(row, deps.open));
		} catch (error) {
			if (isUniqueViolation(error)) return c.json({ error: "Já existe um ambiente para este repositório" }, 409);
			console.error("update dev environment failed", error);
			return c.json({ error: "Failed to update environment" }, 503);
		}
	});

	app.delete("/v1/dev-environments/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const existing = await deps.get(c.req.param("id"), userId).catch(() => null);
			if (!(await deps.remove(c.req.param("id"), userId))) return c.json({ error: "Environment not found" }, 404);
			// Sem ambiente, o cache de dependências não serve mais (melhor esforço).
			if (existing) await deps.clearCache(userId, existing.repo).catch(() => false);
			return c.json({ ok: true });
		} catch (error) {
			console.error("delete dev environment failed", error);
			return c.json({ error: "Failed to delete environment" }, 503);
		}
	});

	/** "Limpar cache do ambiente": apaga as dependências guardadas; a próxima sessão instala do zero. */
	app.delete("/v1/dev-environments/:id/cache", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const env = await deps.get(c.req.param("id"), userId);
			if (!env) return c.json({ error: "Environment not found" }, 404);
			const cleared = await deps.clearCache(userId, env.repo);
			return c.json({ ok: true, cleared });
		} catch (error) {
			console.error("clear dev environment cache failed", error instanceof Error ? error.message : "unknown");
			return c.json({ error: "Failed to clear cache" }, 503);
		}
	});

	/** Define/substitui um segredo (write-only). */
	app.put("/v1/dev-environments/:id/secrets/:name", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const nameResult = validateSecretName(c.req.param("name"));
			if ("error" in nameResult) return c.json({ error: nameResult.error }, 400);
			const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
			const valueResult = validateSecretValue(body?.value);
			if ("error" in valueResult) return c.json({ error: valueResult.error }, 400);
			const id = c.req.param("id");
			// A tela mostra segredos salvos como bolinhas; devolver isso não pode apagar o valor real.
			if (isMaskedSecretValue(valueResult.value)) {
				const kept = await deps.get(id, userId);
				if (!kept) return c.json({ error: "Environment not found" }, 404);
				return c.json(toDevEnvironmentView(kept, deps.open));
			}
			if (!deps.secretBoxReady()) return c.json({ error: SECRET_BOX_ERROR }, 503);
			const current = await deps.get(id, userId);
			if (!current) return c.json({ error: "Environment not found" }, 404);
			let existing: Record<string, string> = {};
			try {
				existing = current.sealedSecrets ? deps.open(current.sealedSecrets) : {};
			} catch {
				return c.json({ error: "Não foi possível abrir os segredos salvos (chave de criptografia trocada?). Apague-os e defina de novo." }, 409);
			}
			if (!(nameResult.name in existing) && Object.keys(existing).length >= DEV_ENV_MAX_SECRETS) {
				return c.json({ error: `No máximo ${DEV_ENV_MAX_SECRETS} segredos por ambiente` }, 400);
			}
			const row = await deps.update(id, userId, { sealedSecrets: deps.seal({ ...existing, [nameResult.name]: valueResult.value }) });
			if (!row) return c.json({ error: "Environment not found" }, 404);
			return c.json(toDevEnvironmentView(row, deps.open));
		} catch (error) {
			console.error("set dev environment secret failed", error);
			return c.json({ error: "Failed to save secret" }, 503);
		}
	});

	/** Define/substitui vários segredos de uma vez (write-only): { entries: [{ name, value }] }. */
	app.put("/v1/dev-environments/:id/secrets", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const body = (await c.req.json().catch(() => null)) as { entries?: unknown } | null;
			const entries = body?.entries;
			if (!Array.isArray(entries) || entries.length === 0) return c.json({ error: "Informe ao menos um segredo" }, 400);
			if (entries.length > DEV_ENV_MAX_SECRETS) return c.json({ error: `No máximo ${DEV_ENV_MAX_SECRETS} segredos por ambiente` }, 400);
			const incoming: Record<string, string> = {};
			const errors: { index: number; name: string; error: string }[] = [];
			let masked = 0;
			entries.forEach((entry: unknown, index) => {
				const record = typeof entry === "object" && entry !== null ? (entry as { name?: unknown; value?: unknown }) : {};
				const name = validateSecretName(record.name);
				if ("error" in name) {
					errors.push({ index, name: typeof record.name === "string" ? record.name.slice(0, 64) : "", error: name.error });
					return;
				}
				if (typeof record.value === "string" && isMaskedSecretValue(record.value)) {
					masked++;
					return;
				}
				const value = validateSecretValue(record.value);
				if ("error" in value) {
					errors.push({ index, name: name.name, error: value.error });
					return;
				}
				incoming[name.name] = value.value;
			});
			if (errors.length > 0) return c.json({ error: "Há segredos inválidos", errors }, 400);
			const id = c.req.param("id");
			if (Object.keys(incoming).length === 0 && masked > 0) {
				// Só valores mascarados: nada a gravar, os segredos salvos ficam como estão.
				const kept = await deps.get(id, userId);
				if (!kept) return c.json({ error: "Environment not found" }, 404);
				return c.json(toDevEnvironmentView(kept, deps.open));
			}
			if (!deps.secretBoxReady()) return c.json({ error: SECRET_BOX_ERROR }, 503);
			const current = await deps.get(id, userId);
			if (!current) return c.json({ error: "Environment not found" }, 404);
			let existing: Record<string, string> = {};
			try {
				existing = current.sealedSecrets ? deps.open(current.sealedSecrets) : {};
			} catch {
				return c.json({ error: "Não foi possível abrir os segredos salvos (chave de criptografia trocada?). Apague-os e defina de novo." }, 409);
			}
			const merged = { ...existing, ...incoming };
			if (Object.keys(merged).length > DEV_ENV_MAX_SECRETS) return c.json({ error: `No máximo ${DEV_ENV_MAX_SECRETS} segredos por ambiente` }, 400);
			const row = await deps.update(id, userId, { sealedSecrets: deps.seal(merged) });
			if (!row) return c.json({ error: "Environment not found" }, 404);
			return c.json(toDevEnvironmentView(row, deps.open));
		} catch (error) {
			console.error("set dev environment secrets failed", error instanceof Error ? error.message : "unknown");
			return c.json({ error: "Failed to save secrets" }, 503);
		}
	});

	app.delete("/v1/dev-environments/:id/secrets/:name", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const id = c.req.param("id");
			const current = await deps.get(id, userId);
			if (!current) return c.json({ error: "Environment not found" }, 404);
			if (!current.sealedSecrets) return c.json(toDevEnvironmentView(current, deps.open));
			let existing: Record<string, string>;
			try {
				existing = deps.open(current.sealedSecrets);
			} catch {
				// Segredos ilegíveis (chave trocada): remover o nome apaga tudo para o usuário recomeçar.
				const row = await deps.update(id, userId, { sealedSecrets: null });
				return c.json(row ? toDevEnvironmentView(row, deps.open) : { error: "Environment not found" }, row ? 200 : 404);
			}
			const name = c.req.param("name");
			if (!(name in existing)) return c.json({ error: "Secret not found" }, 404);
			delete existing[name];
			const row = await deps.update(id, userId, { sealedSecrets: Object.keys(existing).length ? deps.seal(existing) : null });
			if (!row) return c.json({ error: "Environment not found" }, 404);
			return c.json(toDevEnvironmentView(row, deps.open));
		} catch (error) {
			console.error("delete dev environment secret failed", error);
			return c.json({ error: "Failed to delete secret" }, 503);
		}
	});

	return app;
}
