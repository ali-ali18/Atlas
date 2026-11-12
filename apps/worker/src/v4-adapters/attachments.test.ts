/**
 * Anexos do v4 no worker: porta escopada (dono e conversa), zip lido pelo leitor de `@workspace/files`, cópia para a VM pelo
 * `Sandbox` do run e a confirmação do nome. Sem rede e sem banco: a fonte e o gerenciador da VM são falsos.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/attachments.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttachmentKind } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { createV4Sandbox } from "./sandbox.js";
import { attachmentCopyHandler } from "./sandbox-attachments.js";
import { createV4Attachments, type V4AttachmentsSource } from "./attachments.js";

const enc = (text: string) => new TextEncoder().encode(text);

/** Zip sem compressão (método 0) com as entradas dadas: o leitor do `@workspace/files/zip` lê este formato. */
function zipOf(files: Record<string, Uint8Array>): Uint8Array {
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [name, data] of Object.entries(files)) {
		const nameBytes = enc(name);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint32(18, data.length, true);
		lv.setUint32(22, data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(20, data.length, true);
		cv.setUint32(24, data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		locals.push(local);
		centrals.push(central);
		offset += local.length;
	}
	const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, centrals.length, true);
	ev.setUint16(10, centrals.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const all = [...locals, ...centrals, eocd];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of all) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

type Item = { id: string; filename: string; kind: AttachmentKind; text?: string; bytes?: Uint8Array };

/** Fonte do run: a lista e o cache de extração (o que o `AttachmentRuntime` do processador entrega). */
function source(items: Item[]): V4AttachmentsSource {
	const refOf = (item: Item) => ({ id: item.id, filename: item.filename, mime: "application/octet-stream", size: (item.bytes ?? enc(item.text ?? "")).byteLength, kind: item.kind });
	return {
		list: async () => items.map(refOf),
		cache: {
			get: async (ref) => {
				const item = items.find((candidate) => candidate.id === ref.id);
				if (!item) return null;
				return { extracted: { text: item.text ?? "", textCut: false, tables: [], notes: [] }, bytes: async () => item.bytes ?? enc(item.text ?? "") };
			},
		},
	};
}

const ITEMS: Item[] = [
	{ id: "txt1", filename: "relatorio.txt", kind: "text", text: "conteúdo do relatório" },
	{ id: "zip1", filename: "pacote.zip", kind: "zip", bytes: zipOf({ "dados/notas.txt": enc("nota um"), "dados/imagem.bin": new Uint8Array([0, 1, 2]) }) },
];

test("escopo: outro dono ou conversa sem id não vê nenhum anexo", async () => {
	const port = createV4Attachments({ scope: { ownerId: "dono-a", conversationId: "conv-1" }, source: source(ITEMS) });
	assert.equal((await port.list("dono-a")).length, 2);
	assert.deepEqual(await port.list("dono-b"), []);
	assert.equal(await port.open("dono-b", "txt1"), null);
	assert.notEqual(await port.open("dono-a", "txt1"), null);
	const noConversation = createV4Attachments({ scope: { ownerId: "dono-a", conversationId: null }, source: source(ITEMS) });
	assert.deepEqual(await noConversation.list("dono-a"), []);
	assert.equal(await noConversation.open("dono-a", "txt1"), null);
});

test("texto: o conteúdo vem do cache do run e os bytes saem do armazenamento sob demanda", async () => {
	const port = createV4Attachments({ scope: { ownerId: "dono-a", conversationId: "conv-1" }, source: source(ITEMS) });
	const file = await port.open("dono-a", "txt1");
	assert.ok(file);
	assert.equal(file.content.text, "conteúdo do relatório");
	assert.equal(new TextDecoder().decode(await file.bytes()), "conteúdo do relatório");
	assert.equal(await file.archive(), null, "texto não tem entradas de zip");
	assert.equal(await file.archiveEntry("qualquer.txt", 100), null);
});

test("zip: lista as entradas, lê uma de texto e devolve null para a que não existe", async () => {
	const port = createV4Attachments({ scope: { ownerId: "dono-a", conversationId: "conv-1" }, source: source(ITEMS) });
	const file = await port.open("dono-a", "zip1");
	assert.ok(file);
	const listing = await file.archive();
	assert.deepEqual(listing?.entries.map((entry) => entry.name), ["dados/notas.txt", "dados/imagem.bin"]);
	assert.equal(listing?.unsafeReason, null);
	assert.equal(new TextDecoder().decode((await file.archiveEntry("dados/notas.txt", 1024)) ?? new Uint8Array()), "nota um");
	assert.equal(await file.archiveEntry("dados/ausente.txt", 1024), null);
});

test("zip: entrada maior que o teto é recusada com o motivo, nunca cortada", async () => {
	const port = createV4Attachments({ scope: { ownerId: "dono-a", conversationId: "conv-1" }, source: source(ITEMS) });
	const file = await port.open("dono-a", "zip1");
	assert.ok(file);
	await assert.rejects(() => file.archiveEntry("dados/notas.txt", 3));
});

test("cópia: grava em anexos/ pela VM e recusa nomes que saem da pasta", async () => {
	const writes: string[] = [];
	const manager = { execWriteFile: async (_sid: string, params: { path: string; bytes: Uint8Array }) => { writes.push(params.path); return { path: params.path, bytes: params.bytes.byteLength }; } } as unknown as SandboxManager;
	const ctx = { userId: "dono-a", runId: "run-1", sessionId: "vm-1", manager };
	const ok = await attachmentCopyHandler(ctx, { name: "relatorio.txt", bytes: enc("oi") });
	assert.deepEqual(ok, { ok: true, data: { path: "anexos/relatorio.txt" } });
	for (const name of ["..", ".", "a/b", "a\\b", "x\u0007y"]) {
		const refused = await attachmentCopyHandler(ctx, { name, bytes: enc("x") });
		assert.equal(refused.ok, false, `o nome "${name}" devia ser recusado`);
	}
	assert.deepEqual(writes, ["anexos/relatorio.txt"]);
});

test("cópia sem recurso de escrita na VM falha com a frase honesta", async () => {
	const result = await attachmentCopyHandler({ userId: "dono-a", runId: "run-1", sessionId: "vm-1", manager: {} as SandboxManager }, { name: "a.txt", bytes: enc("x") });
	assert.equal(result.ok, false);
});

test("cópia pelo Sandbox do run: a VM da conversa do dono recebe o arquivo; outro dono é recusado antes de subir a VM", async () => {
	const writes: Array<{ sessionId: string; path: string; size: number }> = [];
	let created = 0;
	const manager = {
		resolveSession: async () => ({ sessionId: "vm-conv-1" }),
		execWriteFile: async (sessionId: string, params: { path: string; bytes: Uint8Array }) => {
			writes.push({ sessionId, path: params.path, size: params.bytes.byteLength });
			return { path: params.path, bytes: params.bytes.byteLength };
		},
		destroySession: async () => undefined,
	} as unknown as SandboxManager;
	const sandbox = createV4Sandbox({ scope: { userId: "dono-a", runId: "run-1", conversationId: "conv-1" }, deps: { createManager: () => { created += 1; return manager; } } });
	const result = await sandbox.run("dono-a", { kind: "attachments.copy", params: { name: "relatorio.txt", bytes: enc("abc") } });
	assert.deepEqual(result, { ok: true, data: { path: "anexos/relatorio.txt" } });
	assert.deepEqual(writes, [{ sessionId: "vm-conv-1", path: "anexos/relatorio.txt", size: 3 }]);
	const other = await sandbox.run("dono-b", { kind: "attachments.copy", params: { name: "x.txt", bytes: enc("x") } });
	assert.equal(other.ok, false);
	assert.equal(writes.length, 1);
	assert.ok(created >= 1);
});
