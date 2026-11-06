/**
 * Configurações do bot no v4 (worker), com db falso que filtra por dono.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/settings.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsCapability } from "@workspace/agent";
import { createV4Settings, ROLE_MODELS_UNAVAILABLE, type V4SettingsDeps } from "./settings.js";

function fakeDb() {
	const bots = new Map<string, { ownerId: string; name: string; snippet: string; description: string | null; language: string; notify: boolean }>([["bot-1", { ownerId: "user-a", name: "Atlas", snippet: "Resumo", description: null, language: "pt-BR", notify: true }]]);
	const updates: Array<{ botId: string; patch: Record<string, unknown>; ownerId: string }> = [];
	const deps: V4SettingsDeps = {
		getBot: async (userId, botId) => {
			const bot = bots.get(botId);
			return bot && bot.ownerId === userId ? { name: bot.name, snippet: bot.snippet, description: bot.description, language: bot.language, notify: bot.notify } : null;
		},
		update: async (botId, patch, ownerId) => {
			const bot = bots.get(botId);
			if (!bot || bot.ownerId !== ownerId) throw new Error("Bot not found");
			updates.push({ botId, patch: patch as Record<string, unknown>, ownerId });
			Object.assign(bot, patch);
		},
	};
	return { deps, bots, updates };
}

test("lê as configurações do bot do dono (modelo por papel ainda vazio)", async () => {
	const { deps } = fakeDb();
	const view = await createV4Settings({ botId: "bot-1", deps }).get("user-a");
	assert.deepEqual(view, { name: "Atlas", snippet: "Resumo", description: "", language: "pt-BR", notify: true, roleModels: {} });
});

test("muda idioma, notificação e perfil pelo dono", async () => {
	const { deps, updates } = fakeDb();
	const settings = createV4Settings({ botId: "bot-1", deps });
	const view = await settings.update("user-a", { language: "auto", notify: false, profile: { name: "Nova", description: "Ajuda com contas" } });
	assert.equal(view.language, "auto");
	assert.equal(view.notify, false);
	assert.equal(view.name, "Nova");
	assert.equal(view.description, "Ajuda com contas");
	assert.deepEqual(updates[0]?.patch, { language: "auto", notify: false, name: "Nova", description: "Ajuda com contas" });
});

test("declara que não guarda modelo por papel (a capacidade não anuncia set_role_model)", () => {
	const { deps } = fakeDb();
	assert.equal(createV4Settings({ botId: "bot-1", deps }).supportsRoleModels, false);
	assert.deepEqual(createSettingsCapability(createV4Settings({ botId: "bot-1", deps })).tools.map((t) => t.name), ["settings_get", "settings_update", "update_bot_profile"]);
});

test("modelo por papel: falha honesta, sem gravar nada", async () => {
	const { deps, updates } = fakeDb();
	await assert.rejects(createV4Settings({ botId: "bot-1", deps }).update("user-a", { roleModels: { helper: "anthropic/claude-haiku-5.5" }, notify: false }), (error: Error) => error.message === ROLE_MODELS_UNAVAILABLE && /not available yet/.test(error.message));
	assert.equal(updates.length, 0);
	// devolver o papel ao padrão também é uma troca: mesma resposta
	await assert.rejects(createV4Settings({ botId: "bot-1", deps }).update("user-a", { roleModels: { helper: null } }), /not available yet/);
});

test("IDOR: usuário B não lê nem muda o bot do A (mesmo erro de bot inexistente)", async () => {
	const { deps, bots, updates } = fakeDb();
	const settings = createV4Settings({ botId: "bot-1", deps });
	await assert.rejects(settings.get("user-b"), /Bot not found/);
	await assert.rejects(settings.update("user-b", { notify: false }), /Bot not found/);
	assert.equal(updates.length, 0);
	assert.equal(bots.get("bot-1")?.notify, true);
	await assert.rejects(createV4Settings({ botId: "inexistente", deps }).get("user-a"), /Bot not found/);
});

test("idioma inválido é recusado antes de gravar", async () => {
	const { deps, updates } = fakeDb();
	await assert.rejects(createV4Settings({ botId: "bot-1", deps }).update("user-a", { language: "klingon" }), /Unknown language/);
	assert.equal(updates.length, 0);
});
