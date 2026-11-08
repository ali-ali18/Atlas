import assert from "node:assert/strict";
import { test } from "node:test";
import type { queueAgendaEventWakes } from "@workspace/db";
import { ENGINE_V4_OFF } from "@workspace/shared";
import { wakeIntentsForEmail, type EmailIntentWakeDeps } from "./agenda-event.js";

const EVENT = { source: "email" as const, from: "ana@empresa.com", subject: "Fatura", hasAttachment: false };
const NOW = new Date("2026-11-08T12:00:00Z");

function rig(over: Partial<EmailIntentWakeDeps> & { policy?: unknown } = {}) {
	const queued: Array<Parameters<typeof queueAgendaEventWakes>[0]> = [];
	const loaded: string[][] = [];
	const deps: EmailIntentWakeDeps = {
		gate: () => ({ enabled: true, accounts: ["user_a"] }),
		engineDefault: () => "all",
		loadBot: async (userId, botId) => (loaded.push([userId, botId]), botId === "bot_1" && userId === "user_a" ? { policyJson: over.policy ?? {} } : null),
		queue: (async (input) => (queued.push(input), { marked: 2 })) as typeof queueAgendaEventWakes,
		now: () => NOW,
		...over,
	};
	delete (deps as { policy?: unknown }).policy;
	return { deps, queued, loaded };
}

test("v4 ligado para a conta e para o bot: marca as intenções do dono e do bot, com o espaçamento mínimo da agenda", async () => {
	const { deps, queued } = rig();
	assert.deepEqual(await wakeIntentsForEmail({ userId: "user_a", botId: "bot_1", event: EVENT }, deps), { marked: 2 });
	assert.deepEqual(queued, [{ userId: "user_a", botId: "bot_1", event: EVENT, now: NOW, minGapMinutes: 30 }]);
});

test("flag desligada ou conta fora da lista: nada acontece e o banco nem é consultado", async () => {
	for (const gate of [ENGINE_V4_OFF, { enabled: true, accounts: ["outra"] }, { enabled: false, accounts: ["user_a"] }]) {
		const { deps, queued, loaded } = rig({ gate: () => gate });
		assert.deepEqual(await wakeIntentsForEmail({ userId: "user_a", botId: "bot_1", event: EVENT }, deps), { marked: 0, skipped: "v4_off" });
		assert.equal(queued.length + loaded.length, 0);
	}
});

test("bot de outro dono ou inexistente: não marca (a consulta é escopada pelo dono)", async () => {
	const { deps, queued } = rig();
	assert.deepEqual(await wakeIntentsForEmail({ userId: "user_a", botId: "bot_de_outro", event: EVENT }, deps), { marked: 0, skipped: "no_bot" });
	assert.equal(queued.length, 0);
});

test("bot com o motor fixado fora do v4: não marca (o item não rodaria; o v2 segue como antes)", async () => {
	const { deps, queued } = rig({ policy: { engine: "v2" } });
	assert.deepEqual(await wakeIntentsForEmail({ userId: "user_a", botId: "bot_1", event: EVENT }, deps), { marked: 0, skipped: "engine_not_v4" });
	assert.equal(queued.length, 0);
});
