import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { PersistUserArtifactInput } from "@workspace/db";
import { CodeRunnerUnavailableError, type CodeRunInput, type CodeRunResult } from "@workspace/sandbox";
import { openPptx } from "../files/deck/pptx-zip.fixtures.js";
import { HAS_PYTHON_PPTX, runPythonLocally } from "../files/deck/template/local-runner.fixtures.js";
import { buildFixtureTemplate } from "../files/deck/template/template.fixtures.js";
import { executeCreateFile, type CreateFileDeps } from "./create-file.js";

const ctxBase = { userId: "user-a", runId: "run-1", conversationId: "conv-1" };
const SLIDES = [{ layout: "title", title: "Plano" }, { layout: "bullets", title: "Metas", bullets: ["a", "b"] }];

async function page(): Promise<Uint8Array> {
	return new Uint8Array(await sharp({ create: { width: 40, height: 22, channels: 3, background: "#ffffff" } }).png().toBuffer());
}

function result(extra: Partial<CodeRunResult> = {}): CodeRunResult {
	return { exitCode: 0, timedOut: false, stdout: "", stderr: "", truncated: false, durationMs: 5, outputs: [], omitted: [], inputNames: [], crashed: false, ...extra };
}

function deps(overrides: Partial<CreateFileDeps> = {}) {
	const persisted: PersistUserArtifactInput[] = [];
	const value: Partial<CreateFileDeps> = {
		persist: vi.fn(async (input: PersistUserArtifactInput) => {
			persisted.push(input);
			return { id: `art-${persisted.length}`, kind: input.kind, meta: { ...(input.meta ?? {}), mime: input.mime, size: input.bytes.byteLength }, runId: input.runId ?? null, conversationId: input.conversationId ?? null, createdAt: new Date() };
		}),
		nextVersion: vi.fn(async () => 1),
		countRunFiles: vi.fn(async () => 0),
		...overrides,
	};
	return { value, persisted };
}

describe("conferência visual automática do deck", () => {
	it("com modelo que enxerga imagens e sandbox: renderiza, guarda as páginas e devolve os ids de visão", async () => {
		const runPython = vi.fn(async (input: CodeRunInput) => {
			expect(input.files?.[0]?.name).toBe("deck.pptx");
			return result({ previews: [{ name: "slide-2.png", bytes: await page() }, { name: "slide-1.png", bytes: await page() }] });
		});
		const d = deps({ runPython });
		const out = await executeCreateFile({ filename: "d.pptx", slides: SLIDES }, { ...ctxBase, canSeeImages: true }, d.value);
		expect(runPython).toHaveBeenCalledTimes(1);
		const images = d.persisted.filter((p) => p.kind === "image");
		expect(images).toHaveLength(2);
		expect(images[0]).toMatchObject({ userId: "user-a", conversationId: "conv-1", meta: { source: "deck_preview", origin: "assistant", alt: "slide-1.png" } });
		expect(out.visionArtifactIds).toHaveLength(2);
		expect(out.summary).toMatch(/Visual check: 2 slide images are attached to the next message/);
		expect(out.summary).toMatch(/call create_file again with the same filename/);
		// o cartão de arquivo é do .pptx, não das páginas
		expect(out.fileEvent).toMatchObject({ format: "pptx" });
	});

	it("sem sandbox: segue sem prévia e diz a verdade (estimativa pelo texto)", async () => {
		const runPython = vi.fn(async () => {
			throw new CodeRunnerUnavailableError("O executor de código não está instalado neste servidor.");
		});
		const out = await executeCreateFile({ filename: "d.pptx", slides: SLIDES }, { ...ctxBase, canSeeImages: true }, deps({ runPython }).value);
		expect(out.visionArtifactIds).toBeUndefined();
		expect(out.summary).toMatch(/Visual check not done: the code runner is not available on this server/);
		expect(out.summary).toMatch(/only estimated from text length/);
	});

	it("modelo sem visão não gasta a sandbox", async () => {
		const runPython = vi.fn();
		const out = await executeCreateFile({ filename: "d.pptx", slides: SLIDES }, { ...ctxBase, canSeeImages: false }, deps({ runPython }).value);
		expect(runPython).not.toHaveBeenCalled();
		expect(out.summary).toMatch(/Visual check not done: this model cannot view images/);
	});

	it("LibreOffice sem páginas: aviso honesto, arquivo criado mesmo assim", async () => {
		const runPython = vi.fn(async () => result({ exitCode: 1, stderr: "soffice falhou" }));
		const d = deps({ runPython });
		const out = await executeCreateFile({ filename: "d.pptx", slides: SLIDES }, { ...ctxBase, canSeeImages: true }, d.value);
		expect(d.persisted.filter((p) => p.kind === "file")).toHaveLength(1);
		expect(out.summary).toMatch(/Visual check not done: LibreOffice could not render the file/);
	});

	it("avisos de layout e conferência visual vêm juntos", async () => {
		const long = "Este item descreve em detalhes todo o cenário do mercado e as metas do trimestre seguinte";
		const runPython = vi.fn(async () => result({ previews: [{ name: "slide-1.png", bytes: await page() }] }));
		const out = await executeCreateFile(
			{ filename: "d.pptx", slides: [{ layout: "bullets", title: "Muito", bullets: Array.from({ length: 10 }, () => `${long}. ${long}`) }] },
			{ ...ctxBase, canSeeImages: true },
			deps({ runPython }).value,
		);
		expect(out.summary).toMatch(/Layout check found 1 issue/);
		expect(out.summary).toMatch(/Visual check: 1 slide image is attached/);
	});
});

describe("template_file_id: acesso restrito ao dono", () => {
	const mine = (bytes: Uint8Array, filename = "modelo.pptx") => ({ id: "tpl-1", kind: "file", bytes: Buffer.from(bytes), conversationId: "outra-conversa", meta: { filename, ext: filename.split(".").pop(), mime: "x" } }) as never;

	it("outro usuário não alcança o modelo (404 genérico) e nada é criado", async () => {
		const template = await buildFixtureTemplate();
		const loadArtifact = vi.fn(async (id: string, userId: string) => (id === "tpl-1" && userId === "user-a" ? mine(template) : null));
		const runPython = vi.fn(runPythonLocally);
		const d = deps({ runPython, loadArtifact });
		await expect(executeCreateFile({ filename: "d.pptx", slides: SLIDES, template_file_id: "tpl-1" }, { ...ctxBase, userId: "user-b" }, d.value)).rejects.toThrow(/Template tpl-1 was not found/);
		expect(loadArtifact).toHaveBeenCalledWith("tpl-1", "user-b");
		expect(runPython).not.toHaveBeenCalled();
		expect(d.persisted).toHaveLength(0);
	});

	it("não aceita URL, arquivo que não é pptx nem macros", async () => {
		const d = deps({ runPython: vi.fn(), loadArtifact: vi.fn(async () => mine(new TextEncoder().encode("oi"), "notas.txt")) });
		await expect(executeCreateFile({ filename: "d.pptx", slides: SLIDES, template_file_id: "https://x.com/m.pptx" }, ctxBase, d.value)).rejects.toThrow(/not a URL/);
		await expect(executeCreateFile({ filename: "d.pptx", slides: SLIDES, template_file_id: "tpl-1" }, ctxBase, d.value)).rejects.toThrow(/not found/);
		const macro = deps({ runPython: vi.fn(), loadArtifact: vi.fn(async () => mine(await buildFixtureTemplate({ macro: true }))) });
		await expect(executeCreateFile({ filename: "d.pptx", slides: SLIDES, template_file_id: "tpl-1" }, ctxBase, macro.value)).rejects.toThrow(/macros/);
		expect(macro.persisted).toHaveLength(0);
	});

	it("sem o executor de código, o modelo é avisado e sugerido a usar um tema", async () => {
		const template = await buildFixtureTemplate();
		const runPython = vi.fn(async () => {
			throw new CodeRunnerUnavailableError("O executor de código não está disponível agora.");
		});
		const d = deps({ runPython, loadArtifact: vi.fn(async () => mine(template)) });
		await expect(executeCreateFile({ filename: "d.pptx", slides: SLIDES, template_file_id: "tpl-1" }, ctxBase, d.value)).rejects.toThrow(/needs the code runner.*built-in theme/);
	});

	it.skipIf(!HAS_PYTHON_PPTX)("preenche o modelo anexado à conversa e cria o arquivo do dono", async () => {
		const template = await buildFixtureTemplate();
		const attachmentFiles = { list: async () => [{ id: "att-1", filename: "marca.pptx" }], bytes: async (id: string) => (id === "att-1" ? template : null) };
		const loadArtifact = vi.fn(async () => null);
		const d = deps({ runPython: runPythonLocally, loadArtifact });
		const out = await executeCreateFile({ filename: "plano.pptx", slides: SLIDES, template_file_id: "att-1", theme: "dark" }, { ...ctxBase, attachmentFiles }, d.value);
		expect(loadArtifact).not.toHaveBeenCalled();
		const file = d.persisted.find((p) => p.kind === "file")!;
		expect(file).toMatchObject({ userId: "user-a", conversationId: "conv-1", meta: { format: "pptx" } });
		const { slideNames, read } = await openPptx(file.bytes);
		expect(slideNames).toHaveLength(2);
		expect(await read(slideNames[0]!)).toContain("Plano");
		expect(out.summary).toMatch(/theme is ignored with a template/);
		expect(out.fileEvent).toMatchObject({ filename: "plano.pptx" });
	});
});
