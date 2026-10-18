import { Hono } from "hono";
import {
	getSkillDetail,
	listBotSkills,
	revokeSkillVersion,
	setSkillEnabled,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

function parseId(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return value.trim();
}

function parseEnabled(body: unknown): boolean | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as Record<string, unknown>;
	if (!("enabled" in raw)) return null;
	if (typeof raw.enabled !== "boolean") return null;
	return raw.enabled;
}

function parseVersionId(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const raw = body as Record<string, unknown>;
	return parseId(raw.versionId);
}

export function createSkillRoutes() {
	const app = new Hono<AuthEnv>();

	app.get("/v1/bots/:botId/skills", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		if (!botId) {
			return c.json({ error: "Missing bot id" }, 400);
		}
		try {
			const skills = await listBotSkills(userId, botId);
			return c.json({ skills });
		} catch (error) {
			console.error("list bot skills failed", error);
			return c.json({ error: "Failed to list skills" }, 503);
		}
	});

	app.get("/v1/bots/:botId/skills/:skillId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const skillId = parseId(c.req.param("skillId"));
		if (!botId || !skillId) {
			return c.json({ error: "Missing bot id or skill id" }, 400);
		}
		try {
			const skill = await getSkillDetail(userId, botId, skillId);
			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}
			return c.json({ skill });
		} catch (error) {
			console.error("get skill detail failed", error);
			return c.json({ error: "Failed to get skill" }, 503);
		}
	});

	app.patch("/v1/bots/:botId/skills/:skillId", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const skillId = parseId(c.req.param("skillId"));
		if (!botId || !skillId) {
			return c.json({ error: "Missing bot id or skill id" }, 400);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const enabled = parseEnabled(json);
		if (enabled === null) {
			return c.json({ error: "Invalid body: expected { enabled: boolean }" }, 400);
		}

		try {
			const result = await setSkillEnabled({
				userId,
				botId,
				skillId,
				enabled,
			});
			if (result.count !== 1) {
				return c.json({ error: "Skill not found" }, 404);
			}
			return c.json({ ok: true });
		} catch (error) {
			console.error("set skill enabled failed", error);
			return c.json({ error: "Failed to update skill" }, 503);
		}
	});

	app.post("/v1/bots/:botId/skills/:skillId/revoke", async (c) => {
		const { userId } = scopeFor(c.get("session"));
		const botId = parseId(c.req.param("botId"));
		const skillId = parseId(c.req.param("skillId"));
		if (!botId || !skillId) {
			return c.json({ error: "Missing bot id or skill id" }, 400);
		}

		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const versionId = parseVersionId(json);
		if (!versionId) {
			return c.json({ error: "Invalid body: expected { versionId: string }" }, 400);
		}

		try {
			const skill = await getSkillDetail(userId, botId, skillId);
			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}
			const belongs = skill.versions.some((v) => v.id === versionId);
			if (!belongs) {
				return c.json({ error: "Skill version not found" }, 404);
			}
			await revokeSkillVersion({
				userId,
				botId,
				versionId,
			});
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof Error && error.message === "Skill version not found") {
				return c.json({ error: "Skill version not found" }, 404);
			}
			console.error("revoke skill version failed", error);
			return c.json({ error: "Failed to revoke skill version" }, 503);
		}
	});

	return app;
}
