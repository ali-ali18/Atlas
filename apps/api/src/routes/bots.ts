import { Hono } from "hono";
import type {
	CreateBotInput,
	ListBotsResponse,
	UpdateBotInput,
} from "@workspace/shared";
import {
	isBotLanguageSetting,
	readCodingModel,
	readSubagentModel,
	DELEGATE_MODEL_MAX_CHARS,
	parseModelRef,
	isValidTimeZone,
	parseClockMinutes,
	PROACTIVE_MAX_PER_DAY_MAX,
	PROACTIVE_MAX_PER_DAY_MIN,
} from "@workspace/shared";
import { emailService } from "@workspace/agent-runtime";
import { GroupError, createBot, deleteBot, listBotExchange, listBots, updateBot, validateGroupMemberIds, prisma } from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { validateProviderModel, type ModelValidation } from "../providers/model-catalog.js";
import { isKnownModelId } from "./models.js";

function parseMemberIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter(
		(item): item is string => typeof item === "string" && item.trim().length > 0,
	);
}

// Formas aceitas: as do motor de avatar (packages/ui/src/lib/avatar) e as do
// primeiro desenho do bloub, que bots antigos continuam guardando.
const BOT_SHAPES = new Set([
	"blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder",
	"hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop",
	"leaf", "square", "sparkle", "clover", "flower", "heart", "house", "star",
	"rond", "goutte", "nuage", "hexagone", "triangle", "galet",
]);

export function parseShape(value: unknown): string | undefined {
	return typeof value === "string" && BOT_SHAPES.has(value.trim())
		? value.trim()
		: undefined;
}

function parseCreateBot(body: unknown): CreateBotInput | null {
	if (typeof body !== "object" || body === null) return null;
	const { name, snippet, color, shape, description, openRouterModel, language, memberIds } = body as {
		name?: unknown;
		snippet?: unknown;
		color?: unknown;
		shape?: unknown;
		description?: unknown;
		openRouterModel?: unknown;
		language?: unknown;
		memberIds?: unknown;
	};

	if (typeof name !== "string" || name.trim().length === 0) return null;

	const input: CreateBotInput = { name: name.trim() };
	if (typeof snippet === "string") input.snippet = snippet;
	if (typeof color === "string" && color.trim()) input.color = color.trim();
	const createShape = parseShape(shape);
	if (createShape) input.shape = createShape;
	if (typeof description === "string") input.description = description;
	if (typeof openRouterModel === "string" && openRouterModel.trim()) {
		input.openRouterModel = openRouterModel.trim();
	} else if (openRouterModel === null) {
		input.openRouterModel = null;
	}
	if (language !== undefined) {
		if (!isBotLanguageSetting(language)) return null;
		input.language = language;
	}
	const members = parseMemberIds(memberIds);
	if (members) input.memberIds = members;

	return input;
}

function parseUpdateBot(body: unknown): UpdateBotInput | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as Record<string, unknown>;
	const patch: UpdateBotInput = {};

	if ("name" in raw) {
		if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
			return null;
		}
		patch.name = raw.name.trim();
	}
	if ("snippet" in raw) {
		if (typeof raw.snippet !== "string") return null;
		patch.snippet = raw.snippet;
	}
	if ("color" in raw) {
		if (typeof raw.color !== "string" || raw.color.trim().length === 0) {
			return null;
		}
		patch.color = raw.color.trim();
	}
	if ("shape" in raw) {
		const parsed = parseShape(raw.shape);
		if (!parsed) return null;
		patch.shape = parsed;
	}
	if ("description" in raw) {
		if (raw.description !== null && typeof raw.description !== "string") {
			return null;
		}
		patch.description = raw.description;
	}
	if ("openRouterModel" in raw) {
		if (
			raw.openRouterModel !== null &&
			typeof raw.openRouterModel !== "string"
		) {
			return null;
		}
		patch.openRouterModel = raw.openRouterModel;
	}
	if ("language" in raw) {
		if (!isBotLanguageSetting(raw.language)) return null;
		patch.language = raw.language;
	}
	if ("sectionId" in raw) {
		if (
			raw.sectionId !== null &&
			typeof raw.sectionId !== "string"
		) {
			return null;
		}
		patch.sectionId = raw.sectionId;
	}
	if ("pinned" in raw) {
		if (typeof raw.pinned !== "boolean") return null;
		patch.pinned = raw.pinned;
	}
	if ("notify" in raw) {
		if (typeof raw.notify !== "boolean") return null;
		patch.notify = raw.notify;
	}
	if ("pinOrder" in raw) {
		if (
			raw.pinOrder !== null &&
			(typeof raw.pinOrder !== "number" || !Number.isFinite(raw.pinOrder))
		) {
			return null;
		}
		patch.pinOrder = raw.pinOrder;
	}
	if ("memberIds" in raw) {
		const members = parseMemberIds(raw.memberIds);
		if (!members) return null;
		patch.memberIds = members;
	}
	if ("isPrimary" in raw) {
		if (typeof raw.isPrimary !== "boolean") return null;
		patch.isPrimary = raw.isPrimary;
	}
	if ("policyJson" in raw) {
		if (
			raw.policyJson !== null &&
			(typeof raw.policyJson !== "object" || Array.isArray(raw.policyJson))
		) {
			return null;
		}
		patch.policyJson = raw.policyJson;
	}

	return patch;
}

/**
 * Modo proativo (`policyJson.proactive`): campos válidos e só no bot principal.
 * Devolve a mensagem de erro (pt-BR, vai ao usuário) ou null.
 */
export function checkProactivePolicy(policyJson: unknown, isPrimary: boolean): string | null {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return null;
	const raw = (policyJson as Record<string, unknown>).proactive;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return "Configuração do modo proativo inválida";
	const row = raw as Record<string, unknown>;
	if (row.enabled !== undefined && typeof row.enabled !== "boolean") return "Modo proativo: \"enabled\" deve ser verdadeiro ou falso";
	if (row.enabled === true && !isPrimary) return "Disponível no bot principal";
	if (row.routineMode !== undefined && row.routineMode !== "suggest" && row.routineMode !== "auto") return "Modo proativo: rotinas devem ser Sugerir ou Automático";
	if (row.maxPerDay !== undefined) {
		const value = row.maxPerDay;
		if (typeof value !== "number" || !Number.isInteger(value) || value < PROACTIVE_MAX_PER_DAY_MIN || value > PROACTIVE_MAX_PER_DAY_MAX) {
			return `Modo proativo: máximo por dia deve ser de ${PROACTIVE_MAX_PER_DAY_MIN} a ${PROACTIVE_MAX_PER_DAY_MAX}`;
		}
	}
	for (const key of ["quietStart", "quietEnd"] as const) {
		if (row[key] !== undefined && parseClockMinutes(row[key]) === null) return "Modo proativo: horário de silêncio inválido (use HH:MM)";
	}
	if (row.timezone !== undefined && !isValidTimeZone(row.timezone)) return "Modo proativo: fuso horário inválido";
	return null;
}

/** Modelo dos subagentes (`policyJson.subagentModel`): string curta e id que existe no catálogo. */
async function checkSubagentModel(
	policyJson: unknown,
	isKnownModel: (id: string) => Promise<boolean | null>,
): Promise<{ status: 400 | 503; error: string } | null> {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return null;
	const raw = (policyJson as Record<string, unknown>).subagentModel;
	if (raw === undefined || raw === null) return null;
	const model = readSubagentModel(policyJson);
	if (!model || model.length > DELEGATE_MODEL_MAX_CHARS) {
		return { status: 400, error: "Invalid subagentModel: expected a model id" };
	}
	const known = await isKnownModel(model);
	if (known === null) return { status: 503, error: "Model list unavailable, try again" };
	if (!known) return { status: 400, error: "Invalid subagentModel: unknown model" };
	return null;
}

export function createBotRoutes(
	deps: { isKnownModel?: (id: string) => Promise<boolean | null>; validateModel?: (userId: string, model: string) => Promise<ModelValidation> } = {},
) {
	const isKnownModel = deps.isKnownModel ?? isKnownModelId;
	const validateModel = deps.validateModel ?? validateProviderModel;
	const app = new Hono<AuthEnv>();

	app.get("/v1/bots", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const bots = await listBots(userId);
			const body: ListBotsResponse = { bots };
			return c.json(body);
		} catch (error) {
			console.error("list bots failed", error);
			return c.json({ error: "Failed to list bots" }, 503);
		}
	});

	/** Conversa entre dois bots do usuário (somente leitura), mais recentes primeiro por página. */
	app.get("/v1/bots/:botId/exchanges/:peerBotId", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const limitRaw = c.req.query("limit");
			const limit = limitRaw === undefined ? undefined : Number(limitRaw);
			if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: "Invalid limit" }, 400);
			const cursor = c.req.query("cursor");
			if (cursor && Number.isNaN(new Date(cursor).getTime())) return c.json({ error: "Invalid cursor" }, 400);
			const body = await listBotExchange({
				userId,
				botId: c.req.param("botId"),
				peerBotId: c.req.param("peerBotId"),
				...(limit !== undefined ? { limit } : {}),
				cursor: cursor || null,
			});
			if (!body) return c.json({ error: "Bot not found" }, 404);
			return c.json(body);
		} catch (error) {
			console.error("list bot exchange failed", error);
			return c.json({ error: "Failed to load exchange" }, 503);
		}
	});

	app.post("/v1/bots", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const input = parseCreateBot(json);
		if (!input) {
			return c.json({ error: "Invalid body: expected { name }" }, 400);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			const validation = input.openRouterModel ? await validateModel(userId, input.openRouterModel) : {};
			if ("error" in validation) return c.json({ error: validation.error }, validation.status);
			// Grupo (memberIds): só bots do próprio dono, de 2 a 8.
			if (input.memberIds && input.memberIds.length > 0) input.memberIds = await validateGroupMemberIds(userId, input.memberIds);
			const bot = await createBot(input, userId);
			return c.json({ ...bot, ...(validation.warning ? { warnings: [validation.warning] } : {}) }, 201);
		} catch (error) {
			if (error instanceof GroupError) return c.json({ error: error.message }, error.code === "not_found" ? 404 : 400);
			console.error("create bot failed", error);
			return c.json({ error: "Failed to create bot" }, 503);
		}
	});

	app.patch("/v1/bots/:id", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing bot id" }, 400);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const patch = parseUpdateBot(json);
		if (!patch || Object.keys(patch).length === 0) {
			return c.json({ error: "Invalid body: no updatable fields" }, 400);
		}


		try {
			const { userId } = scopeFor(c.get("session"));
			const owned = await prisma.bot.findFirst({ where: { id, ownerId: userId }, select: { id: true, memberIds: true, isPrimary: true } });
   if (!owned) return c.json({ error: "Bot not found" }, 404);
   if (patch.memberIds !== undefined) {
    // Só grupos têm membros; a lista passa pela mesma validação da criação.
    if (owned.memberIds.length === 0) return c.json({ error: "Apenas grupos têm membros" }, 400);
    patch.memberIds = await validateGroupMemberIds(userId, patch.memberIds, id);
   }
   if (patch.isPrimary === true && owned.memberIds.length > 0) return c.json({ error: "Um grupo não pode ser o Bot principal" }, 400);
   const proactiveError = checkProactivePolicy(patch.policyJson, patch.isPrimary ?? owned.isPrimary);
   if (proactiveError) return c.json({ error: proactiveError }, 400);
   const validation = patch.openRouterModel ? await validateModel(userId, patch.openRouterModel) : {};
   if ("error" in validation) return c.json({ error: validation.error }, validation.status);
   const policy = patch.policyJson as Record<string, unknown> | null | undefined;
   if (policy && "chatgptFallbackModel" in policy && policy.chatgptFallbackModel !== null) {
    try {
     if (typeof policy.chatgptFallbackModel !== "string" || parseModelRef(policy.chatgptFallbackModel).provider !== "openrouter")
      return c.json({ error: "O fallback deve ser um modelo OpenRouter ou nenhum" }, 400);
    } catch { return c.json({ error: "Modelo de fallback inválido" }, 400); }
   }
   const subagent = readSubagentModel(patch.policyJson);
   const subagentValidation = subagent ? await validateModel(userId, subagent) : {};
   if ("error" in subagentValidation) return c.json({ error: subagentValidation.error }, subagentValidation.status);
   const coding = readCodingModel(patch.policyJson);
   if (coding) {
    if (coding.length > DELEGATE_MODEL_MAX_CHARS) return c.json({ error: "Invalid codingModel: expected a model id" }, 400);
    const codingValidation = await validateModel(userId, coding);
    if ("error" in codingValidation) return c.json({ error: codingValidation.error }, codingValidation.status);
    const known = parseModelRef(coding).provider !== "openrouter" ? true : await isKnownModel(coding);
    if (known === null) return c.json({ error: "Model list unavailable, try again" }, 503);
    if (!known) return c.json({ error: "Invalid codingModel: unknown model" }, 400);
   }
   const invalid = await checkSubagentModel(patch.policyJson, async (model) => parseModelRef(model).provider !== "openrouter" ? true : isKnownModel(model));
   if (invalid) return c.json({ error: invalid.error }, invalid.status);
   const bot = await updateBot(id, patch, userId);
			return c.json({ ...bot, ...(validation.warning || subagentValidation.warning ? { warnings: [validation.warning, subagentValidation.warning].filter(Boolean) } : {}) });
		} catch (error) {
			if (error instanceof Error && (error.message === "Bot not found" || error.message === "Section not found")) {
				return c.json({ error: error.message }, 404);
			}
			if (error instanceof GroupError) return c.json({ error: error.message }, error.code === "not_found" ? 404 : 400);
			console.error("update bot failed", error);
			return c.json({ error: "Failed to update bot" }, 503);
		}
	});

	app.delete("/v1/bots/:id", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing bot id" }, 400);
		}

		try {
			const { userId } = scopeFor(c.get("session"));
			// Apaga a caixa de e-mail no provedor antes (a linha some junto com o bot).
			await emailService.disableForBot({ userId, botId: id }).catch(() => undefined);
			await deleteBot(id, userId);
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof Error && error.message === "Bot not found") {
				return c.json({ error: "Bot not found" }, 404);
			}
			console.error("delete bot failed", error);
			return c.json({ error: "Failed to delete bot" }, 503);
		}
	});

	return app;
}
