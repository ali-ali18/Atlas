import { Hono } from "hono";
import type {
	ListSectionsResponse,
	UpdateSectionInput,
} from "@workspace/shared";
import {
	createSection,
	deleteSection,
	listSections,
	updateSection,
} from "@workspace/db";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";

export function createSectionRoutes() {
	const app = new Hono<AuthEnv>();

	app.get("/v1/sections", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const sections = await listSections(userId);
			const body: ListSectionsResponse = { sections };
			return c.json(body);
		} catch (error) {
			console.error("list sections failed", error);
			return c.json({ error: "Failed to list sections" }, 503);
		}
	});

	app.post("/v1/sections", async (c) => {
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const name =
			typeof json === "object" && json !== null
				? (json as { name?: unknown }).name
				: undefined;
		if (typeof name !== "string" || name.trim().length === 0) {
			return c.json({ error: "Invalid body: expected { name }" }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const section = await createSection({ name: name.trim() }, userId);
			return c.json(section, 201);
		} catch (error) {
			console.error("create section failed", error);
			return c.json({ error: "Failed to create section" }, 503);
		}
	});

	app.patch("/v1/sections/:id", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing section id" }, 400);
		}
		let json: unknown;
		try {
			json = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (typeof json !== "object" || json === null) {
			return c.json({ error: "Invalid body" }, 400);
		}
		const raw = json as Record<string, unknown>;
		const patch: UpdateSectionInput = {};
		if ("name" in raw) {
			if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
				return c.json({ error: "Invalid name" }, 400);
			}
			patch.name = raw.name.trim();
		}
		if ("order" in raw) {
			if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
				return c.json({ error: "Invalid order" }, 400);
			}
			patch.order = raw.order;
		}
		if (Object.keys(patch).length === 0) {
			return c.json({ error: "Invalid body: no updatable fields" }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			const section = await updateSection(id, patch, userId);
			return c.json(section);
		} catch (error) {
			if (error instanceof Error && error.message === "Section not found") {
				return c.json({ error: "Section not found" }, 404);
			}
			console.error("update section failed", error);
			return c.json({ error: "Failed to update section" }, 503);
		}
	});

	app.delete("/v1/sections/:id", async (c) => {
		const id = c.req.param("id");
		if (!id.trim()) {
			return c.json({ error: "Missing section id" }, 400);
		}
		try {
			const { userId } = scopeFor(c.get("session"));
			await deleteSection(id, userId);
			return c.json({ ok: true });
		} catch (error) {
			if (error instanceof Error && error.message === "Section not found") {
				return c.json({ error: "Section not found" }, 404);
			}
			console.error("delete section failed", error);
			return c.json({ error: "Failed to delete section" }, 503);
		}
	});

	return app;
}
