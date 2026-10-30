/**
 * Falha de leitura de artefato observável: `loadArtifactForUserDetailed` diz o MOTIVO
 * (outro dono/inexistente, uri vazia, arquivo ilegível); `loadArtifactForUser` segue devolvendo null.
 * Prisma stubado, disco temporário. Runner: `pnpm exec tsx --test src/artifacts.load-reason.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const dir = await mkdtemp(join(tmpdir(), "atlas-load-reason-"));
process.env.ATLAS_ARTIFACT_DIR = dir;
const { prisma } = await import("./client.js");
const { loadArtifactForUser, loadArtifactForUserDetailed } = await import("./artifacts.js");

type Row = { id: string; userId: string | null; runId: string | null; conversationId: string | null; kind: string; uri: string; metaJson: unknown; createdAt: Date };

function withRows<T>(rows: Row[], run: () => Promise<T>): Promise<T> {
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const original = artifact.findFirst;
	artifact.findFirst = async ({ where }: { where: { id: string; OR: Array<{ userId?: { in: string[] } }> } }) =>
		rows.find((row) => row.id === where.id && where.OR[0]?.userId?.in.includes(row.userId ?? "") === true) ?? null;
	return run().finally(() => {
		artifact.findFirst = original;
	});
}

const base = { runId: null, conversationId: null, kind: "image", metaJson: { mime: "image/png" }, createdAt: new Date() };

test("leitura detalhada: ok devolve os bytes", async () => {
	const uri = join(dir, "ok.png");
	await writeFile(uri, "bytes");
	await withRows([{ ...base, id: "ok", userId: "user-a", uri }], async () => {
		const result = await loadArtifactForUserDetailed("ok", "user-a");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.artifact.bytes.toString(), "bytes");
	});
});

test("leitura detalhada: arquivo sumido vira read_failed:ENOENT e a versão antiga segue null", async () => {
	const uri = join(dir, "sumiu.png");
	await withRows([{ ...base, id: "gone", userId: "user-a", uri }], async () => {
		assert.deepEqual(await loadArtifactForUserDetailed("gone", "user-a"), { ok: false, reason: "read_failed:ENOENT" });
		assert.equal(await loadArtifactForUser("gone", "user-a"), null);
	});
});

test("leitura detalhada: outro dono e id inexistente viram not_found_for_owner; uri vazia vira empty_uri", async () => {
	const uri = join(dir, "alheio.png");
	await writeFile(uri, "x");
	await withRows(
		[
			{ ...base, id: "alheio", userId: "user-a", uri },
			{ ...base, id: "vazio", userId: "user-a", uri: "" },
		],
		async () => {
			assert.deepEqual(await loadArtifactForUserDetailed("alheio", "user-b"), { ok: false, reason: "not_found_for_owner" });
			assert.deepEqual(await loadArtifactForUserDetailed("nao-existe", "user-a"), { ok: false, reason: "not_found_for_owner" });
			assert.deepEqual(await loadArtifactForUserDetailed("vazio", "user-a"), { ok: false, reason: "empty_uri" });
		},
	);
});
