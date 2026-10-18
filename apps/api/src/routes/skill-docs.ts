import { Hono, type Context } from "hono";
import {
	SkillDocError,
	createSkillDoc,
	deleteDraftSkillDocs,
	deleteSkillDoc,
	getSkillDoc,
	listSkillDocs,
	setSkillDocEnabled,
	updateSkillDoc,
	type SkillDocRecord,
} from "@workspace/db";
import {
	SKILL_DOCUMENT_MAX_BYTES,
	contentDisposition,
	parseSkillMarkdown,
	renderSkillMarkdown,
	type SkillStatus,
} from "@workspace/shared";
import { builtinSkills } from "@workspace/agent-runtime";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

/**
 * Skills em Markdown (PLANO-SKILLS K0). Tudo atrás de `requireUser`; o dono vem
 * da sessão (`scopeFor`), nunca de body/query/param. Skill de outro dono
 * responde 404, igual a inexistente.
 */

/** JSON escapa aspas e quebras de linha: folga sobre o teto do documento. */
const MAX_REQUEST_BYTES = SKILL_DOCUMENT_MAX_BYTES * 3;
const NOT_FOUND = { error: "Skill não encontrada." } as const;
const STATUS_BY_KIND = { invalid: 400, conflict: 409, stale: 409, limit: 422, not_found: 404 } as const;

type Json = Record<string, unknown>;
type ParsedBody = { ok: true; value: unknown; markdown: boolean } | { ok: false; status: 400 | 413; error: string };

/** Lê o corpo com teto de tamanho antes de qualquer parse. */
async function readBody(c: Context<AuthEnv>): Promise<ParsedBody> {
	const declared = Number(c.req.header("Content-Length"));
	if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
		return { ok: false, status: 413, error: "Documento grande demais para uma skill." };
	}
	const raw = await c.req.text().catch(() => null);
	if (raw === null) return { ok: false, status: 400, error: "Corpo da requisição inválido." };
	if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
		return { ok: false, status: 413, error: "Documento grande demais para uma skill." };
	}
	if ((c.req.header("Content-Type") ?? "").toLowerCase().startsWith("text/markdown")) {
		return { ok: true, value: raw, markdown: true };
	}
	try {
		return { ok: true, value: JSON.parse(raw), markdown: false };
	} catch {
		return { ok: false, status: 400, error: "JSON inválido." };
	}
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resumo para lista: sem o corpo (vem em GET /:id). */
function toSummary(skill: SkillDocRecord) {
	const { body: _body, ...rest } = skill;
	return rest;
}

function failure(c: Context<AuthEnv>, error: unknown) {
	if (error instanceof SkillDocError) {
		return c.json({ error: error.message, details: error.details }, STATUS_BY_KIND[error.kind]);
	}
	console.error("skill-docs failed", error instanceof Error ? error.message : "erro desconhecido");
	return c.json({ error: "Falha ao processar skills." }, 503);
}

/** Aceita `{ markdown }`, o próprio texto markdown ou os campos soltos. */
function fieldsFrom(body: ParsedBody & { ok: true }): { fields: Json } | { errors: string[] } {
	const markdown = body.markdown ? body.value : isObject(body.value) ? body.value.markdown : undefined;
	if (markdown !== undefined) {
		const parsed = parseSkillMarkdown(markdown);
		if (!parsed.ok) return { errors: parsed.errors };
		const { name, description, tools, body: text } = parsed.skill;
		return { fields: { name, description, tools, body: text } };
	}
	if (!isObject(body.value)) return { errors: ["Corpo inválido: envie markdown ou { name, description, body }."] };
	return { fields: body.value };
}

/** Escopo da skill: `?botId=` ou campo `botId` do JSON; ausente = conta. `undefined` = inválido. */
function resolveBotId(c: Context<AuthEnv>, body: ParsedBody & { ok: true }): string | null | undefined {
	const fromQuery = c.req.query("botId")?.trim();
	if (fromQuery) return fromQuery;
	const value = isObject(body.value) ? body.value.botId : undefined;
	if (value === undefined || value === null || value === "") return null;
	return typeof value === "string" ? value.trim() || null : undefined;
}

export function createSkillDocRoutes() {
	const app = new Hono<AuthEnv>();

	app.get("/v1/skills", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = c.req.query("botId")?.trim();
		try {
			const skills = await listSkillDocs(userId, botId ? { botId } : {});
			return c.json({ skills: skills.map(toSummary) });
		} catch (error) {
			return failure(c, error);
		}
	});

	/** Skills de fábrica (somente leitura, iguais para todos). Antes de `/:id`. */
	app.get("/v1/skills/builtin", (c) => {
		const skills = builtinSkills().map(({ slug, name, description, groups, version, body }) => ({
			slug,
			name,
			description,
			groups,
			version,
			body,
		}));
		return c.json({ skills });
	});

	// Antes de `/:id` para não casar "import" como id.
	app.post("/v1/skills/import", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = await readBody(c);
		if (!body.ok) return c.json({ error: body.error }, body.status);
		const botId = resolveBotId(c, body);
		if (botId === undefined) return c.json({ error: "botId inválido." }, 400);
		const parsed = fieldsFrom(body);
		if ("errors" in parsed) return c.json({ error: parsed.errors.join(" "), details: parsed.errors }, 400);
		try {
			// Conteúdo de terceiros: entra como rascunho desligado até o dono aprovar.
			const skill = await createSkillDoc(userId, {
				name: parsed.fields.name,
				description: parsed.fields.description,
				body: parsed.fields.body,
				tools: parsed.fields.tools,
				botId,
				status: "draft",
				enabled: false,
				createdBy: "user",
			});
			return c.json({ skill, source: "imported" }, 201);
		} catch (error) {
			return failure(c, error);
		}
	});

	/**
	 * Apaga em lote os RASCUNHOS do usuário da sessão e devolve a contagem. Escopo
	 * opcional: `?botId=<id>` (só daquele bot) ou `?scope=account` (só da conta);
	 * sem nenhum, todos os rascunhos do dono. Nunca toca em skill ativa.
	 */
	app.post("/v1/skills/delete-drafts", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = c.req.query("botId")?.trim();
		const accountOnly = c.req.query("scope") === "account";
		try {
			const deleted = await deleteDraftSkillDocs(userId, botId ? { botId } : accountOnly ? { botId: null } : {});
			return c.json({ ok: true, deleted });
		} catch (error) {
			return failure(c, error);
		}
	});

	app.post("/v1/skills", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const body = await readBody(c);
		if (!body.ok) return c.json({ error: body.error }, body.status);
		const parsed = fieldsFrom(body);
		if ("errors" in parsed) return c.json({ error: parsed.errors.join(" "), details: parsed.errors }, 400);
		const botId = resolveBotId(c, body);
		if (botId === undefined) return c.json({ error: "botId inválido." }, 400);
		const enabled = typeof parsed.fields.enabled === "boolean" ? parsed.fields.enabled : undefined;
		try {
			const skill = await createSkillDoc(userId, {
				name: parsed.fields.name,
				description: parsed.fields.description,
				body: parsed.fields.body,
				tools: parsed.fields.tools,
				botId,
				enabled,
				createdBy: "user",
			});
			return c.json({ skill }, 201);
		} catch (error) {
			return failure(c, error);
		}
	});

	app.get("/v1/skills/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const skill = await getSkillDoc(userId, c.req.param("id"));
			return skill ? c.json({ skill }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			return failure(c, error);
		}
	});

	app.get("/v1/skills/:id/export", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			const skill = await getSkillDoc(userId, c.req.param("id"));
			if (!skill) return c.json(NOT_FOUND, 404);
			return new Response(renderSkillMarkdown(skill), {
				status: 200,
				headers: {
					"Content-Type": "text/markdown; charset=utf-8",
					"Content-Disposition": contentDisposition(`${skill.name}.md`, false),
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
				},
			});
		} catch (error) {
			return failure(c, error);
		}
	});

	app.put("/v1/skills/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const id = c.req.param("id");
		const body = await readBody(c);
		if (!body.ok) return c.json({ error: body.error }, body.status);
		const raw = isObject(body.value) ? body.value : {};
		const status: SkillStatus | undefined = raw.status === "active" || raw.status === "draft" ? raw.status : undefined;
		const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
		const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) ? raw.revision : undefined;
		if (raw.status !== undefined && !status) return c.json({ error: "status inválido." }, 400);
		if (raw.enabled !== undefined && enabled === undefined) return c.json({ error: "enabled deve ser booleano." }, 400);

		const contentKeys = ["markdown", "name", "description", "body", "tools"];
		const touchesContent = body.markdown || contentKeys.some((key) => key in raw);
		try {
			if (!touchesContent && status === undefined) {
				if (enabled === undefined) return c.json({ error: "Nada para atualizar." }, 400);
				if (!(await setSkillDocEnabled(userId, id, enabled))) return c.json(NOT_FOUND, 404);
				const skill = await getSkillDoc(userId, id);
				return skill ? c.json({ skill }) : c.json(NOT_FOUND, 404);
			}
			let fields: Json = {};
			if (touchesContent) {
				const parsed = fieldsFrom(body);
				if ("errors" in parsed) return c.json({ error: parsed.errors.join(" "), details: parsed.errors }, 400);
				fields = parsed.fields;
			}
			const skill = await updateSkillDoc(userId, id, {
				name: fields.name,
				description: fields.description,
				body: fields.body,
				tools: fields.tools,
				status,
				enabled,
				expectedRevision: revision,
				updatedBy: "user",
			});
			return c.json({ skill });
		} catch (error) {
			return failure(c, error);
		}
	});

	app.delete("/v1/skills/:id", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		try {
			return (await deleteSkillDoc(userId, c.req.param("id"))) ? c.json({ ok: true }) : c.json(NOT_FOUND, 404);
		} catch (error) {
			return failure(c, error);
		}
	});

	return app;
}
