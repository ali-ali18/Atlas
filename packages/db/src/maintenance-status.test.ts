import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { getMaintenanceStatus, recordMaintenanceResult } from "./maintenance-status.js";

function fakeSettings() {
	let json: unknown = null;
	const delegate = prisma.userSettings as unknown as Record<string, unknown>;
	const original = { findUnique: delegate.findUnique, upsert: delegate.upsert };
	delegate.findUnique = async () => (json === null ? null : { maintenanceStatusJson: json });
	delegate.upsert = async ({ update }: { update: { maintenanceStatusJson: unknown } }) => {
		json = update.maintenanceStatusJson;
		return {};
	};
	return { restore: () => Object.assign(delegate, original), read: () => json };
}

test("grava sucesso e erro por tipo sem apagar o outro; texto limpo de segredos", async () => {
	const fake = fakeSettings();
	try {
		await recordMaintenanceResult("u1", "summary", { ok: true }, new Date("2026-10-19T10:00:00Z"));
		await recordMaintenanceResult("u1", "summary", { ok: false, error: new Error("falhou Authorization: Bearer abcdefghijklmnop") }, new Date("2026-10-19T11:00:00Z"));
		await recordMaintenanceResult("u1", "memory-review", { ok: true }, new Date("2026-10-19T12:00:00Z"));
		const status = await getMaintenanceStatus("u1");
		assert.equal(status.summary?.successAt, "2026-10-19T10:00:00.000Z");
		assert.equal(status.summary?.error?.at, "2026-10-19T11:00:00.000Z");
		assert.equal(status["memory-review"]?.successAt, "2026-10-19T12:00:00.000Z");
		assert.ok(!JSON.stringify(fake.read()).includes("abcdefghijklmnop"));
	} finally {
		fake.restore();
	}
});

test("falha do banco não lança (diagnóstico nunca derruba o job)", async () => {
	const delegate = prisma.userSettings as unknown as Record<string, unknown>;
	const original = delegate.findUnique;
	delegate.findUnique = async () => {
		throw new Error("db fora");
	};
	try {
		await recordMaintenanceResult("u1", "summary", { ok: true });
	} finally {
		delegate.findUnique = original;
	}
});
