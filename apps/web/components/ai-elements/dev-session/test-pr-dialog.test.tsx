import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import { defaultTestPrRepo } from "./test-pr-dialog";

Object.assign(globalThis, { React });

function mockFetch(routes: Record<string, unknown>) {
	globalThis.fetch = (async (url: string | URL | Request) => {
		const u = String(url);
		const key = Object.keys(routes).find((k) => u.includes(k));
		if (!key) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

test("repositório padrão: sessão de código da conversa vence; senão o ambiente mais recente", async () => {
	mockFetch({
		"/v1/dev-sessions": { sessions: [{ repo: "acme/velho", lastActiveAt: "2026-10-01T00:00:00Z" }, { repo: "acme/ativo", lastActiveAt: "2026-10-10T00:00:00Z" }] },
		"/v1/dev-environments": { environments: [{ repo: "acme/env", updatedAt: "2026-10-12T00:00:00Z" }], secretsAvailable: true },
	});
	assert.equal(await defaultTestPrRepo("c1"), "acme/ativo");
	mockFetch({
		"/v1/dev-sessions": { sessions: [] },
		"/v1/dev-environments": { environments: [{ repo: "acme/a", updatedAt: "2026-10-01T00:00:00Z" }, { repo: "acme/b", updatedAt: "2026-10-12T00:00:00Z" }], secretsAvailable: true },
	});
	assert.equal(await defaultTestPrRepo("c1"), "acme/b");
	assert.equal(await defaultTestPrRepo(undefined), "acme/b");
});
