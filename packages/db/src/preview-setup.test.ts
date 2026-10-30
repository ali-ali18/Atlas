/** Estado da prévia completa: escopo por dono e checagem do administrador. Prisma em memória. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSetupState } from "@workspace/shared";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { getPreviewSetup, loadPreviewSetup, savePreviewSetup, deletePreviewSetup, isOwnerUserId } = await import("./preview-setup.js");

type Row = { userId: string; state: unknown };
const rows = new Map<string, Row>();
const users = new Map<string, { email: string }>([["admin", { email: "Owner@Test.local" }], ["b", { email: "b@test.local" }]]);
const p = prisma as unknown as Record<string, unknown>;
p.previewSetup = {
	findUnique: async ({ where }: { where: { userId: string } }) => rows.get(where.userId) ?? null,
	upsert: async ({ where, create, update }: { where: { userId: string }; create: Row; update: Partial<Row> }) => {
		rows.set(where.userId, rows.has(where.userId) ? { ...rows.get(where.userId)!, ...update } : create);
	},
	deleteMany: async ({ where }: { where: { userId: string } }) => { rows.delete(where.userId); },
};
p.user = { findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null };

const state = createSetupState({ domain: "previas.exemplo.com", dnsProvider: "desec", tls: "dns01-proxy", platform: "generic", serverIp: "203.0.113.7" });

test("salva e lê o estado do próprio dono", async () => {
	rows.clear();
	await savePreviewSetup("admin", state);
	assert.deepEqual(await getPreviewSetup("admin"), state);
});

test("usuário B não lê nem apaga o setup do usuário A", async () => {
	rows.clear();
	await savePreviewSetup("admin", state);
	assert.equal(await getPreviewSetup("b"), null);
	await deletePreviewSetup("b");
	assert.deepEqual(await getPreviewSetup("admin"), state);
	await deletePreviewSetup("admin");
	assert.equal(await getPreviewSetup("admin"), null);
});

test("estado corrompido no banco vira null", async () => {
	rows.set("admin", { userId: "admin", state: { v: 9 } });
	assert.equal(await getPreviewSetup("admin"), null);
	// Distingue "não há" de "há mas não lê": quem configura não pode sobrescrever às cegas.
	assert.deepEqual(await loadPreviewSetup("admin"), { kind: "corrupt" });
	assert.deepEqual(await loadPreviewSetup("b"), { kind: "none" });
});

test("só o e-mail de ATLAS_OWNER_EMAIL é administrador (sem diferenciar caixa)", async () => {
	assert.equal(await isOwnerUserId("admin", { ATLAS_OWNER_EMAIL: "owner@test.local" }), true);
	assert.equal(await isOwnerUserId("b", { ATLAS_OWNER_EMAIL: "owner@test.local" }), false);
	assert.equal(await isOwnerUserId("admin", {}), false);
	assert.equal(await isOwnerUserId("ghost", { ATLAS_OWNER_EMAIL: "owner@test.local" }), false);
});
