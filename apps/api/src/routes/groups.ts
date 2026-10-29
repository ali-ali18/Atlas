import { Hono, type Context } from "hono";
import type { Bot, CreateGroupInput } from "@workspace/shared";
import { isBotLanguageSetting, pickLanguageFromAcceptLanguage } from "@workspace/shared";
import {
	GroupError,
	addGroupMember,
	noteBrowserLanguage,
	createGroup,
	getGroupState,
	postGroupUserMessage,
	removeGroupMember,
	setGroupMembers,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { parseShape } from "./bots.js";

type GroupStatus = 400 | 404 | 429;

function statusOf(error: GroupError): GroupStatus {
	if (error.code === "not_found") return 404;
	if (error.code === "busy") return 429;
	return 400;
}

/** Corpo de criação: `{ name, memberIds[], color?, shape? }` (nome e membros são validados no db). */
export function parseCreateGroup(body: unknown): CreateGroupInput | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as Record<string, unknown>;
	if (typeof raw.name !== "string" || raw.name.trim().length === 0) return null;
	if (!Array.isArray(raw.memberIds)) return null;
	const input: CreateGroupInput = { name: raw.name.trim(), memberIds: raw.memberIds as string[] };
	if (typeof raw.color === "string" && raw.color.trim()) input.color = raw.color.trim();
	const shape = parseShape(raw.shape);
	if (shape) input.shape = shape;
	return input;
}

export type GroupRouteDeps = {
	createGroup?: typeof createGroup;
	setGroupMembers?: typeof setGroupMembers;
	addGroupMember?: typeof addGroupMember;
	removeGroupMember?: typeof removeGroupMember;
	postGroupUserMessage?: typeof postGroupUserMessage;
	getGroupState?: typeof getGroupState;
};

/** Grupos de bots: criar, membros, falar no grupo e estado das respostas. Tudo do dono da sessão. */
export function createGroupRoutes(deps: GroupRouteDeps = {}) {
	const create = deps.createGroup ?? createGroup;
	const setMembers = deps.setGroupMembers ?? setGroupMembers;
	const addMember = deps.addGroupMember ?? addGroupMember;
	const removeMember = deps.removeGroupMember ?? removeGroupMember;
	const post = deps.postGroupUserMessage ?? postGroupUserMessage;
	const state = deps.getGroupState ?? getGroupState;
	const app = new Hono<AuthEnv>();

	async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
		try {
			return await c.req.json();
		} catch {
			return undefined;
		}
	}

	function fail(c: Context<AuthEnv>, error: unknown, what: string) {
		if (error instanceof GroupError) return c.json({ error: error.message }, statusOf(error));
		console.error(`${what} failed`, error);
		return c.json({ error: `Failed to ${what}` }, 503);
	}

	app.post("/v1/groups", async (c) => {
		const json = await readJson(c);
		const input = parseCreateGroup(json);
		if (!input) return c.json({ error: "Invalid body: expected { name, memberIds[] }" }, 400);
		if (typeof (json as { language?: unknown }).language === "string" && !isBotLanguageSetting((json as { language: string }).language)) {
			return c.json({ error: "Invalid language" }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const group: Bot = await create(userId, input);
			return c.json(group, 201);
		} catch (error) {
			return fail(c, error, "create group");
		}
	});

	/** Troca a lista inteira de membros (mínimo 2). */
	app.put("/v1/groups/:id/members", async (c) => {
		const json = (await readJson(c)) as { memberIds?: unknown } | undefined;
		if (!json || !Array.isArray(json.memberIds)) return c.json({ error: "Invalid body: expected { memberIds[] }" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			return c.json(await setMembers(userId, c.req.param("id"), json.memberIds));
		} catch (error) {
			return fail(c, error, "update group members");
		}
	});

	app.post("/v1/groups/:id/members", async (c) => {
		const json = (await readJson(c)) as { botId?: unknown } | undefined;
		if (!json || typeof json.botId !== "string" || !json.botId.trim()) return c.json({ error: "Invalid body: expected { botId }" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			return c.json(await addMember(userId, c.req.param("id"), json.botId.trim()), 201);
		} catch (error) {
			return fail(c, error, "add group member");
		}
	});

	app.delete("/v1/groups/:id/members/:botId", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			return c.json(await removeMember(userId, c.req.param("id"), c.req.param("botId")));
		} catch (error) {
			return fail(c, error, "remove group member");
		}
	});

	/** Fala do usuário no grupo; o worker decide quem responde. */
	app.post("/v1/groups/:id/messages", async (c) => {
		const json = (await readJson(c)) as { content?: unknown } | undefined;
		if (!json || typeof json.content !== "string") return c.json({ error: "Invalid body: expected { content }" }, 400);
		try {
			const { userId } = scopeFor(c.get("session"));
			void noteBrowserLanguage(userId, pickLanguageFromAcceptLanguage(c.req.header("accept-language")));
			return c.json(await post({ userId, groupId: c.req.param("id"), content: json.content }), 202);
		} catch (error) {
			return fail(c, error, "post group message");
		}
	});

	/** Quem está respondendo / na fila (alimenta "Bia está respondendo…"). */
	app.get("/v1/groups/:id/state", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const body = await state(userId, c.req.param("id"));
			if (!body) return c.json({ error: "Group not found" }, 404);
			return c.json(body);
		} catch (error) {
			return fail(c, error, "load group state");
		}
	});

	return app;
}
