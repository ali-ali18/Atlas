import { describe, expect, it, vi } from "vitest";
import type { PersistUserArtifactInput } from "@workspace/db";
import { CREATE_FILE_TOOL, executeCreateFile, previewCreateFileArgs, resetStagedFilesForTest, type CreateFileDeps } from "./create-file.js";

function deps(overrides: Partial<CreateFileDeps> = {}) {
	const persisted: PersistUserArtifactInput[] = [];
	const value: Partial<CreateFileDeps> = {
		persist: vi.fn(async (input: PersistUserArtifactInput) => {
			persisted.push(input);
			return {
				id: `art-${persisted.length}`,
				kind: input.kind,
				meta: { ...(input.meta ?? {}), mime: input.mime, size: input.bytes.byteLength },
				runId: input.runId ?? null,
				conversationId: input.conversationId ?? null,
				createdAt: new Date(),
			};
		}),
		nextVersion: vi.fn(async () => 1),
		countRunFiles: vi.fn(async () => 0),
		printPdf: vi.fn(async () => new TextEncoder().encode("%PDF-1.4")),
		...overrides,
	};
	return { value, persisted };
}

const ctx = { userId: "user-1", runId: "run-1", conversationId: "conv-1" };

describe("create_file", () => {
	it("descrição diz quando usar e quando não usar (inglês)", () => {
		const text = CREATE_FILE_TOOL.function.description ?? "";
		expect(text).toMatch(/do NOT paste the document in chat/);
		expect(text).toMatch(/Not for images or executables/);
	});

	it("persiste o artefato do dono e emite o evento file", async () => {
		const d = deps();
		const out = await executeCreateFile({ filename: "../../x/Resumo.md", content: "# oi" }, ctx, d.value);
		expect(d.persisted[0]).toMatchObject({
			userId: "user-1",
			runId: "run-1",
			conversationId: "conv-1",
			kind: "file",
			meta: { filename: "Resumo.md", format: "text", version: 1 },
		});
		expect(out.fileEvent).toMatchObject({
			type: "file",
			artifactId: "art-1",
			filename: "Resumo.md",
			size: 4,
			version: 1,
			runId: "run-1",
		});
		expect(out.summary).toContain("File created: Resumo.md");
		expect(out.summary).not.toContain("# oi");
	});

	it("o mesmo nome sobe a versão", async () => {
		const d = deps({ nextVersion: vi.fn(async () => 2) });
		const out = await executeCreateFile({ filename: "a.txt", content: "x" }, ctx, d.value);
		expect(out.fileEvent.version).toBe(2);
		expect(out.summary).toContain("v2");
	});

	it("pdf passa pelo printPdf injetado", async () => {
		const d = deps();
		const out = await executeCreateFile({ filename: "pvu.pdf", content: "# PVU" }, ctx, d.value);
		expect(d.value.printPdf).toHaveBeenCalledTimes(1);
		expect(out.fileEvent.mime).toBe("application/pdf");
	});

	it("valida args: sem extensão, executável e conteúdo ausente", async () => {
		const d = deps();
		await expect(executeCreateFile({ filename: "semextensao", content: "x" }, ctx, d.value)).rejects.toThrow(/extension/);
		await expect(executeCreateFile({ filename: "a.exe", content: "x" }, ctx, d.value)).rejects.toThrow(/cannot be created/);
		await expect(executeCreateFile({ filename: "a.docx" }, ctx, d.value)).rejects.toThrow(/content is required/);
		expect(d.persisted).toHaveLength(0);
	});

	it("limite de arquivos por run e sem usuário", async () => {
		const d = deps({ countRunFiles: vi.fn(async () => 5) });
		await expect(executeCreateFile({ filename: "a.txt", content: "x" }, ctx, d.value)).rejects.toThrow(/File limit/);
		await expect(executeCreateFile({ filename: "a.txt", content: "x" }, { userId: undefined }, d.value)).rejects.toThrow(/signed-in/);
	});
});


it("cancelamento aborta render e não publica artefato quando renderer termina tarde", async () => {
    const controller = new AbortController();
    let finish!: (value: Uint8Array) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const d = deps({ printPdf: async (_html, signal) => {
        expect(signal).toBeDefined();
        started();
        return new Promise<Uint8Array>((resolve) => { finish = resolve; });
    } });
    const result = executeCreateFile({ filename: "a.pdf", content: "oi" }, { ...ctx, signal: controller.signal }, d.value);
    const rejected = expect(result).rejects.toThrow(/cancel/i);
    await ready;
    controller.abort();
    await rejected;
    finish(new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.persisted).toEqual([]);
    expect(d.value.nextVersion).not.toHaveBeenCalled();
});

describe("create_file em partes (A8)", () => {
	it("junta as partes na ordem e só cria o arquivo na última", async () => {
		resetStagedFilesForTest();
		const d = deps();
		const first = await executeCreateFile({ filename: "grande.md", part: 1, more: true, content: "# A\n" }, ctx, d.value);
		expect(first.fileEvent).toBeUndefined();
		expect(first.summary).toMatch(/Part 1 stored/);
		expect(d.persisted).toHaveLength(0);
		await executeCreateFile({ filename: "grande.md", part: 2, more: true, content: "B\n" }, ctx, d.value);
		const args = { filename: "grande.md", part: 3, content: "C\n" };
		expect(previewCreateFileArgs(args, ctx).content).toBe("# A\nB\nC\n");
		const last = await executeCreateFile(args, ctx, d.value);
		expect(last.fileEvent).toMatchObject({ filename: "grande.md" });
		expect(d.persisted).toHaveLength(1);
		expect(new TextDecoder().decode(d.persisted[0]!.bytes)).toBe("# A\nB\nC\n");
	});

	it("parte fora de ordem ou sem partes anteriores volta erro acionável", async () => {
		resetStagedFilesForTest();
		const d = deps();
		await expect(executeCreateFile({ filename: "x.md", part: 2, content: "b" }, ctx, d.value)).rejects.toThrow(/part=1/);
		await executeCreateFile({ filename: "x.md", part: 1, more: true, content: "a" }, ctx, d.value);
		await expect(executeCreateFile({ filename: "x.md", part: 3, content: "c" }, ctx, d.value)).rejects.toThrow(/send part 2 next/);
	});

	it("renderiza PDF a partir do conteúdo inteiro", async () => {
		resetStagedFilesForTest();
		const d = deps();
		await executeCreateFile({ filename: "r.pdf", part: 1, more: true, content: "# Um\n" }, ctx, d.value);
		await executeCreateFile({ filename: "r.pdf", part: 2, content: "Dois" }, ctx, d.value);
		const html = String((d.value.printPdf as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
		expect(html).toContain("Um");
		expect(html).toContain("Dois");
	});
});
