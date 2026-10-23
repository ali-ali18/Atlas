import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { PersistUserArtifactInput } from "@workspace/db";
import { buildFixtureTemplate } from "../files/deck/template/template.fixtures.js";
import type { CodeRunResult } from "@workspace/sandbox";
import { type DeckFileDeps } from "./deck-file.js";
import { executeInspectPresentation, INSPECT_PRESENTATION_TOOL } from "./inspect-presentation.js";

const ctx = { userId: "user-a", runId: "run-1", conversationId: "conv-1", canSeeImages: true };

const row = (bytes: Uint8Array, filename = "marca.pptx", userId = "user-a") =>
	({ id: "tpl-1", kind: "file", bytes: Buffer.from(bytes), conversationId: "conv-9", meta: { filename, ext: filename.split(".").pop(), mime: "x" }, userId }) as never;

async function deps(overrides: Partial<DeckFileDeps> = {}) {
	const template = await buildFixtureTemplate();
	const persisted: PersistUserArtifactInput[] = [];
	const png = new Uint8Array(await sharp({ create: { width: 30, height: 17, channels: 3, background: "#fff" } }).png().toBuffer());
	const value: DeckFileDeps = {
		runPython: vi.fn(async (): Promise<CodeRunResult> => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "", truncated: false, durationMs: 1, outputs: [], omitted: [], inputNames: [], crashed: false, previews: [{ name: "slide-1.png", bytes: png }] })),
		processImage: (await import("../images/process.js")).processImageForStorage,
		persist: vi.fn(async (input: PersistUserArtifactInput) => {
			persisted.push(input);
			return { id: `img-${persisted.length}`, kind: input.kind, meta: { mime: input.mime }, runId: null, conversationId: null, createdAt: new Date() };
		}),
		loadArtifact: vi.fn(async (id: string, userId: string) => (id === "tpl-1" && userId === "user-a" ? row(template) : null)),
		...overrides,
	};
	return { value, persisted, template };
}

describe("inspect_presentation", () => {
	it("a tool diz quando usar e o que não fazer (inglês, curta)", () => {
		const text = INSPECT_PRESENTATION_TOOL.function.description ?? "";
		expect(text).toMatch(/BEFORE building a deck from a template/);
		expect(text).toMatch(/untrusted data/);
		expect(text.length).toBeLessThan(600);
	});

	it("lista layouts, fonte e cores do modelo e anexa as páginas para o modelo ver", async () => {
		const d = await deps();
		const out = await executeInspectPresentation({ file_id: "tpl-1" }, ctx, d.value);
		expect(out.summary).toContain('"Capa" [title]');
		expect(out.summary).toContain('"Duas colunas" [twoObj]');
		expect(out.summary).toContain("accent1=#C0392B");
		expect(out.summary).toContain("heading Georgia");
		expect(out.summary).toMatch(/1 slide image is attached to the next message/);
		expect(out.visionArtifactIds).toEqual(["img-1"]);
		expect(d.persisted[0]).toMatchObject({ userId: "user-a", kind: "image", meta: { source: "deck_preview" } });
	});

	it("outro usuário recebe 'não encontrado' e a sandbox nem roda", async () => {
		const d = await deps();
		await expect(executeInspectPresentation({ file_id: "tpl-1" }, { ...ctx, userId: "user-b" }, d.value)).rejects.toThrow(/Template tpl-1 was not found/);
		expect(d.value.runPython).not.toHaveBeenCalled();
		expect(d.value.loadArtifact).toHaveBeenCalledWith("tpl-1", "user-b");
	});

	it("valida o id (nada de URL) e o tipo do arquivo", async () => {
		const d = await deps();
		await expect(executeInspectPresentation({ file_id: "https://x.com/a.pptx" }, ctx, d.value)).rejects.toThrow(/never a URL/);
		await expect(executeInspectPresentation({}, ctx, d.value)).rejects.toThrow(/file_id is required/);
		await expect(executeInspectPresentation({ file_id: "tpl-1" }, ctx, await deps({ loadArtifact: vi.fn(async () => row(new Uint8Array([1, 2, 3]), "notas.txt")) }).then((x) => x.value))).rejects.toThrow(/not found/);
		await expect(executeInspectPresentation({ file_id: "tpl-1" }, ctx, await deps({ loadArtifact: vi.fn(async () => row(new Uint8Array([1, 2, 3]), "x.pptx")) }).then((x) => x.value))).rejects.toThrow(/not a valid \.pptx/);
	});

	it("preview=false, modelo sem visão e sandbox ausente: sempre devolve a estrutura e diz o que faltou", async () => {
		const d = await deps();
		const noPreview = await executeInspectPresentation({ file_id: "tpl-1", preview: false }, ctx, d.value);
		expect(noPreview.visionArtifactIds).toBeUndefined();
		expect(d.value.runPython).not.toHaveBeenCalled();
		const blind = await executeInspectPresentation({ file_id: "tpl-1" }, { ...ctx, canSeeImages: false }, d.value);
		expect(blind.summary).toMatch(/this model cannot view images/);
		const failing = await deps({ runPython: vi.fn(async () => { throw new Error("falhou"); }) });
		const out = await executeInspectPresentation({ file_id: "tpl-1" }, ctx, failing.value);
		expect(out.summary).toContain('"Capa" [title]');
		expect(out.summary).toMatch(/Slide images not rendered: the render failed/);
	});

	it("anexo da conversa tem prioridade e não consulta o banco", async () => {
		const d = await deps();
		const attachmentFiles = { list: async () => [{ id: "att-1", filename: "modelo.potx" }], bytes: async () => d.template };
		const out = await executeInspectPresentation({ file_id: "att-1", preview: false }, { ...ctx, attachmentFiles }, d.value);
		expect(out.summary).toContain("Template: 13.333 x 7.5 in");
		expect(d.value.loadArtifact).not.toHaveBeenCalled();
	});
});
