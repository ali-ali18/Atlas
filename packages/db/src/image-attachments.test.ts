import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { loadArtifactForUser, sanitizeArtifactName } = await import("./artifacts.js");
const { loadUserImageHistory, parseImageAttachments, resolveUserImagesCard } = await import("./image-attachments.js");

test("anexos: limite, duplicados e IDs inválidos", () => {
	assert.deepEqual(parseImageAttachments(undefined), []);
	assert.equal(parseImageAttachments(Array(10).fill({ artifactId: "x" })), null);
	assert.equal(parseImageAttachments([{ artifactId: "a" }, { artifactId: "a" }]), null);
	assert.equal(parseImageAttachments([{ artifactId: "../a" }]), null);
	assert.deepEqual(parseImageAttachments([{ artifactId: "a" }]), [{ artifactId: "a" }]);
	assert.equal(sanitizeArtifactName("../folder\\photo.png").includes("/"), false);
});

test("artefato: dono lê, outro usuário não lê nem anexa", async () => {
	const dir = await mkdtemp(join(tmpdir(), "atlas-image-test-"));
	const file = join(dir, "image.png");
	await writeFile(file, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const artifact = prisma.artifact as unknown as { findFirst: (args: unknown) => Promise<unknown>; findMany: (args: unknown) => Promise<unknown> };
	const previous = artifact.findFirst;
	const previousMany = artifact.findMany;
	artifact.findMany = async () => [];
	artifact.findFirst = async (args: unknown) => {
		const where = (args as { where: { id: string; OR: Array<{ userId?: { in: string[] } }> } }).where;
		return where.id === "image-a" && where.OR[0]?.userId?.in.includes("user-a") === true && !where.OR[0]?.userId?.in.includes("user-b")
			? { id: "image-a", kind: "image", uri: file, metaJson: { mime: "image/png", width: 1, height: 1, name: "photo.png" } }
			: null;
	};
	try {
		assert.equal((await loadArtifactForUser("image-a", "user-a"))?.meta.mime, "image/png");
		assert.equal(await loadArtifactForUser("image-a", "user-b"), null);
		assert.deepEqual((await resolveUserImagesCard([{ artifactId: "image-a" }], "user-a"))?.items[0], { artifactId: "image-a", mime: "image/png", width: 1, height: 1, name: "photo.png" });
		await assert.rejects(resolveUserImagesCard([{ artifactId: "image-a" }], "user-b"), /anexo inválido/);
	} finally {
		artifact.findFirst = previous;
		artifact.findMany = previousMany;
		await rm(dir, { recursive: true, force: true });
	}
});

test("histórico de imagens: só artefatos do dono entram; conversa alheia fica vazia", async () => {
	const card = JSON.stringify({ v: 1, kind: "images", origin: "user", items: [
		{ artifactId: "mine", mime: "image/png", width: 1, height: 1, name: "a.png" },
		{ artifactId: "theirs", mime: "image/png", width: 1, height: 1, name: "b.png" },
	] });
	const conversation = prisma.conversation as unknown as { findFirst: (args: unknown) => Promise<unknown> };
	const messages = prisma.conversationMessage as unknown as { findMany: (args: unknown) => Promise<unknown> };
	const artifact = prisma.artifact as unknown as { findMany: (args: unknown) => Promise<unknown> };
	const previous = [conversation.findFirst, messages.findMany, artifact.findMany];
	conversation.findFirst = async (args: unknown) => (args as { where: { userId: { in: string[] } } }).where.userId.in.includes("user-a") ? { id: "c1" } : null;
	messages.findMany = async () => [{ role: "images", content: card }, { role: "user", content: "olha" }];
	artifact.findMany = async (args: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in.filter((id) => id === "mine").map((id) => ({ id }));
	try {
		const groups = await loadUserImageHistory("c1", "user-a");
		assert.deepEqual(groups, [{ userText: "olha", items: [{ artifactId: "mine", name: "a.png" }], missing: ["b.png"] }]);
		assert.deepEqual(await loadUserImageHistory("c1", "user-b"), []);
	} finally {
		conversation.findFirst = previous[0]!; messages.findMany = previous[1]!; artifact.findMany = previous[2]!;
	}
});

test("anexos de arquivo: até 5 por mensagem, só do dono, imagens não contam como arquivo", async () => {
	const { resolveUserFileCards, loadUserFileHistory, userFileIdSet } = await import("./file-attachments.js");
	const { imageAttachmentsOf } = await import("./image-attachments.js");
	const rowsOf = (ids: string[]) => ids.map((id) => ({ id, metaJson: { origin: "user", filename: `${id}.zip`, mime: "application/zip", size: 10 } }));
	const artifact = prisma.artifact as unknown as { findMany: (args: unknown) => Promise<unknown> };
	const messages = prisma.conversationMessage as unknown as { findMany: (args: unknown) => Promise<unknown> };
	const conversation = prisma.conversation as unknown as { findFirst: (args: unknown) => Promise<unknown> };
	const previous = { artifact: artifact.findMany, messages: messages.findMany, conversation: conversation.findFirst };
	artifact.findMany = async (args: unknown) => {
		const where = (args as { where: { id: { in: string[] }; kind: string; userId: { in: string[] } } }).where;
		assert.equal(where.kind, "file");
		return where.userId.in.includes("user-a") ? rowsOf(where.id.in.filter((id) => id.startsWith("f"))) : [];
	};
	try {
		assert.equal((await resolveUserFileCards([{ artifactId: "f1" }, { artifactId: "i1" }], "user-a")).length, 1);
		assert.deepEqual([...await userFileIdSet(["f1", "i1"], "user-a")], ["f1"]);
		assert.deepEqual(await imageAttachmentsOf([{ artifactId: "f1" }, { artifactId: "i1" }], "user-a"), [{ artifactId: "i1" }]);
		assert.deepEqual(await resolveUserFileCards([{ artifactId: "f1" }], "user-b"), []);
		assert.equal((await resolveUserFileCards(Array.from({ length: 5 }, (_, i) => ({ artifactId: `f${i}` })), "user-a")).length, 5);
		await assert.rejects(resolveUserFileCards(Array.from({ length: 6 }, (_, i) => ({ artifactId: `f${i}` })), "user-a"), /anexos demais/);
		// Histórico: só cartões de arquivo do usuário, e só em conversa do dono.
		conversation.findFirst = async (args: unknown) => (JSON.stringify(args).includes("user-a") ? { id: "conv-1" } : null);
		const card = (id: string, origin?: string) => ({ content: JSON.stringify({ v: 1, kind: "file", artifactId: id, filename: `${id}.zip`, mime: "application/zip", size: 10, format: "text", version: 1, ...(origin ? { origin } : {}) }) });
		messages.findMany = async () => [card("f2", "user"), card("f9"), card("f1", "user")];
		assert.deepEqual((await loadUserFileHistory("conv-1", "user-a")).map((file) => file.artifactId), ["f1", "f2"]);
		assert.deepEqual(await loadUserFileHistory("conv-1", "user-b"), []);
	} finally {
		artifact.findMany = previous.artifact;
		messages.findMany = previous.messages;
		conversation.findFirst = previous.conversation;
	}
});
