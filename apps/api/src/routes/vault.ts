import { Hono, type Context } from "hono";
import { getVaultService, isSecretBoxConfigured, parseTotpInput, totpAt, VaultError, type VaultPayload, type VaultService } from "@workspace/agent-runtime";
import { SECRET_NAME_RE, suggestSecretName } from "@workspace/shared";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Cofre do usuário (Configurações > Cofre). Toda rota usa o dono da sessão; item
 * de outro usuário responde 404, igual a item inexistente. Valores só saem em
 * `reveal` (confirmado), e cada revelar/copiar fica no histórico do item.
 */

type Deps = { vault: () => VaultService; ready: () => boolean };
const defaultDeps: Deps = { vault: () => getVaultService(), ready: () => isSecretBoxConfigured() };

const EXTRAS_MAX = 20;

function fail(c: Context, error: unknown): Response {
	if (error instanceof VaultError) {
		const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "unavailable" ? 503 : 400;
		return c.json({ error: error.message }, status);
	}
	console.error("vault route failed", error instanceof Error ? error.name : "error");
	return c.json({ error: "Não foi possível concluir. Tente novamente." }, 500);
}

function str(value: unknown, max = 2_000): string | undefined {
	return typeof value === "string" ? value.slice(0, max) : undefined;
}

function parsePayload(body: Record<string, unknown>): Partial<VaultPayload> {
	const payload: Partial<VaultPayload> = {};
	const value = str(body.value, 20_000);
	if (value !== undefined) payload.value = value;
	const password = str(body.password, 2_000);
	if (password !== undefined) payload.password = password;
	const totp = str(body.totp, 1_000);
	if (totp !== undefined) payload.totp = totp.trim();
	const notes = str(body.notes, 5_000);
	if (notes !== undefined) payload.notes = notes;
	if (Array.isArray(body.extras)) {
		payload.extras = body.extras.slice(0, EXTRAS_MAX).flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const row = item as Record<string, unknown>;
			const name = str(row.name, 80)?.trim();
			const extra = str(row.value, 2_000);
			return name && extra !== undefined ? [{ name, value: extra, secret: row.secret === true }] : [];
		});
	}
	return payload;
}

export function createVaultRoutes(deps: Deps = defaultDeps) {
	const app = new Hono<AuthEnv>();
	const owner = (c: { get: (key: "session") => AuthEnv["Variables"]["session"] }) => scopeFor(c.get("session")).userId;
	const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> => {
		try {
			const json = await c.req.json();
			return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};

	app.get("/v1/vault", async (c) => {
		if (!deps.ready()) return c.json({ items: [], available: false });
		try {
			return c.json({ items: await deps.vault().listMeta(owner(c)), available: true });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.post("/v1/vault", async (c) => {
		const json = await body(c);
		if (!json) return c.json({ error: "Corpo inválido" }, 400);
		if (!deps.ready()) return c.json({ error: "Cofre indisponível: defina CONNECTOR_ENCRYPTION_KEY no servidor." }, 503);
		const kind = json.kind === "login" ? "login" : "secret";
		try {
			const meta = await deps.vault().create(owner(c), {
				kind,
				name: String(json.name ?? ""),
				label: str(json.label, 120),
				description: str(json.description, 300),
				siteUrl: str(json.siteUrl, 500),
				username: str(json.username, 300),
				payload: parsePayload(json),
			});
			return c.json({ item: meta }, 201);
		} catch (error) {
			return fail(c, error);
		}
	});

	/** Grava segredos simples direto no cofre (cartão `secret_request` e aviso do composer). O valor nunca vai ao chat. */
	app.post("/v1/vault/secrets", async (c) => {
		const json = await body(c);
		const entries: unknown[] | null = json && Array.isArray(json.entries) ? json.entries : null;
		if (!json || !entries) return c.json({ error: "Corpo inválido" }, 400);
		if (!deps.ready()) return c.json({ error: "Cofre indisponível: defina CONNECTOR_ENCRYPTION_KEY no servidor." }, 503);
		const unique = json.mode === "unique";
		const userId = owner(c);
		const vault = deps.vault();
		const saved: Array<{ name: string; id: string }> = [];
		try {
			const taken = new Set((await vault.listMeta(userId)).map((item) => item.name));
			for (const raw of entries.slice(0, 20)) {
				if (!raw || typeof raw !== "object") continue;
				const row = raw as Record<string, unknown>;
				const value = typeof row.value === "string" ? row.value : "";
				let name = typeof row.name === "string" ? row.name.trim() : "";
				if (!value) throw new VaultError(`Informe o valor de ${name || "cada segredo"}.`, "invalid");
				if (!SECRET_NAME_RE.test(name)) {
					if (!unique) throw new VaultError(`Nome inválido: ${name.slice(0, 40)}`, "invalid");
					name = suggestSecretName(name);
				}
				if (unique && taken.has(name)) {
					let n = 2;
					while (taken.has(`${name}-${n}`)) n += 1;
					name = `${name}-${n}`;
				}
				const meta = await vault.upsertSecret(userId, name, value, str(row.description, 300) ?? "");
				taken.add(meta.name);
				saved.push({ name: meta.name, id: meta.id });
			}
			return c.json({ saved }, 201);
		} catch (error) {
			return fail(c, error);
		}
	});

	app.post("/v1/vault/totp/preview", async (c) => {
		const json = await body(c);
		const config = typeof json?.input === "string" ? parseTotpInput(json.input) : null;
		if (!config) return c.json({ ok: false, error: "Chave 2FA inválida (cole a chave base32 ou o link otpauth://)." }, 400);
		return c.json({ ok: true, ...totpAt(config) });
	});

	app.get("/v1/vault/:id", async (c) => {
		try {
			const vault = deps.vault();
			const userId = owner(c);
			const id = c.req.param("id");
			const [item, audit] = await Promise.all([vault.getMeta(userId, id), vault.auditLog(userId, id)]);
			return c.json({ item, audit: audit.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })) });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.patch("/v1/vault/:id", async (c) => {
		const json = await body(c);
		if (!json) return c.json({ error: "Corpo inválido" }, 400);
		const payload = parsePayload(json);
		// Campo vazio no formulário = não mexer no valor; remover o 2FA é explícito.
		if (payload.value === "") delete payload.value;
		if (payload.password === "") delete payload.password;
		if (json.removeTotp === true) payload.totp = "";
		else if (payload.totp === "") delete payload.totp;
		try {
			const item = await deps.vault().update(owner(c), c.req.param("id"), {
				name: str(json.name, 64),
				label: str(json.label, 120),
				description: str(json.description, 300),
				siteUrl: str(json.siteUrl, 500),
				username: str(json.username, 300),
				...(Object.keys(payload).length > 0 ? { payload } : {}),
			});
			return c.json({ item });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.delete("/v1/vault/:id", async (c) => {
		try {
			await deps.vault().remove(owner(c), c.req.param("id"));
			return c.body(null, 204);
		} catch (error) {
			return fail(c, error);
		}
	});

	/** Revela o conteúdo (a tela pede confirmação; o corpo precisa de `confirm: true`). Fica no histórico. */
	app.post("/v1/vault/:id/reveal", async (c) => {
		const json = await body(c);
		if (json?.confirm !== true) return c.json({ error: "Confirme para revelar." }, 400);
		try {
			// `purpose: "copy"` (botão Copiar) fica no histórico como "copiado", não "revelado".
			const copy = json?.purpose === "copy";
			const { meta, payload } = await deps.vault().reveal(owner(c), c.req.param("id"), copy ? { detail: str(json?.what, 60) } : {}, copy ? "copied" : "revealed");
			c.header("Cache-Control", "no-store");
			return c.json({ item: meta, payload });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.post("/v1/vault/:id/copy", async (c) => {
		const json = await body(c);
		try {
			await deps.vault().recordCopy(owner(c), c.req.param("id"), str(json?.what, 60) ?? "valor");
			return c.body(null, 204);
		} catch (error) {
			return fail(c, error);
		}
	});

	app.get("/v1/vault/:id/totp", async (c) => {
		try {
			c.header("Cache-Control", "no-store");
			return c.json(await deps.vault().totpCode(owner(c), c.req.param("id"), { actor: "user" }));
		} catch (error) {
			return fail(c, error);
		}
	});

	return app;
}
