import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadedAutonomy } from "@workspace/db";
import { capForExternalContent, resolveRunAutonomy, type RunAutonomyDeps } from "./run-autonomy.js";

const NOW = new Date("2026-10-18T12:00:00.000Z");

function deps(level: "autonomous" | "balanced" | "always_ask") {
	const calls: unknown[] = [];
	const loaded: LoadedAutonomy = {
		policy: { level, exceptions: [{ tool: "email_send", mode: "never_ask" }] },
		source: "default",
		expired: [],
		applied: [],
		botName: "Taldo",
	};
	const d: RunAutonomyDeps = {
		load: async (input) => (calls.push(input), loaded),
		notify: async () => undefined,
	};
	return { d, calls };
}

test("run disparado por e-mail nunca roda em Autônomo (teto Equilibrado), mantendo as exceções", async () => {
	const { d } = deps("autonomous");
	const policy = await resolveRunAutonomy({ userId: "u", botId: "b", origin: "email", now: NOW }, d);
	assert.equal(policy.level, "balanced");
	assert.deepEqual(policy.exceptions, [{ tool: "email_send", mode: "never_ask" }]);
});

test("a política real do dono continua disponível para o envio de e-mail (uncapped)", async () => {
	const { d } = deps("autonomous");
	const policy = await resolveRunAutonomy({ userId: "u", botId: "b", origin: "email", now: NOW, uncapped: true }, d);
	assert.equal(policy.level, "autonomous");
});

test("chat comum e níveis mais restritos não mudam; e-mail aplica a validade como run com humano", async () => {
	const chat = deps("autonomous");
	assert.equal((await resolveRunAutonomy({ userId: "u", origin: "chat", now: NOW }, chat.d)).level, "autonomous");
	const ask = deps("always_ask");
	assert.equal((await resolveRunAutonomy({ userId: "u", origin: "email", now: NOW }, ask.d)).level, "always_ask");
	assert.equal((ask.calls[0] as { applyExpiry: boolean }).applyExpiry, true);
	assert.equal(capForExternalContent({ level: "balanced", exceptions: [] }).level, "balanced");
});
