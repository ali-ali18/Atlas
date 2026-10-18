import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const { loadArtifactForUser, persistUserArtifact } = vi.hoisted(() => ({
	loadArtifactForUser: vi.fn(), persistUserArtifact: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ loadArtifactForUser, persistUserArtifact }));
import { executeShowImage } from "./show-image.js";

const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "blue" } }).png().toBuffer();

describe("show_image", () => {
	beforeEach(() => { vi.clearAllMocks(); persistUserArtifact.mockResolvedValue({ id: "image-1" }); });

	it("mostra screenshot como artefato e evento sem bytes", async () => {
		const onImages = vi.fn(async () => undefined);
		const result = await executeShowImage({ source: "screenshot", alt: "Tela atual" }, {
			userId: "user-1", runId: "run-1", manager: { execScreenshot: vi.fn(async () => png) }, getSessionId: async () => "session-1", remaining: 6, onImages,
		});
		expect(result.count).toBe(1);
		expect(result.remaining).toBe(5);
		expect(persistUserArtifact).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", kind: "image" }));
		expect(onImages).toHaveBeenCalledWith({ type: "images", origin: "assistant", items: [expect.objectContaining({ artifactId: "image-1", alt: "Tela atual", width: 8, height: 6 })] });
		expect(JSON.stringify(onImages.mock.calls)).not.toContain(png.toString("base64"));
	});

	it("recusa artefato de outro dono sem emitir evento", async () => {
		loadArtifactForUser.mockResolvedValue(null);
		const onImages = vi.fn();
		await expect(executeShowImage({ source: "artifact", artifact_id: "other" }, { userId: "user-1", manager: { execScreenshot: vi.fn() }, getSessionId: async () => "s", remaining: 6, onImages })).rejects.toThrow("não encontrada");
		expect(onImages).not.toHaveBeenCalled();
		expect(loadArtifactForUser).toHaveBeenCalledWith("other", "user-1");
		expect(persistUserArtifact).not.toHaveBeenCalled();
	});

	it("reenvia screenshot legado sem metadados como imagem processada", async () => {
		loadArtifactForUser.mockResolvedValue({ id: "legacy-shot", kind: "screenshot", meta: {}, bytes: png });
		const onImages = vi.fn(async () => undefined);
		const result = await executeShowImage({ source: "artifact", artifact_id: "legacy-shot", alt: "Captura anterior" }, {
			userId: "user-1", runId: "run-2", conversationId: "conversation-1", manager: { execScreenshot: vi.fn() }, getSessionId: async () => "s", remaining: 6, onImages,
		});
		expect(loadArtifactForUser).toHaveBeenCalledWith("legacy-shot", "user-1");
		expect(persistUserArtifact).toHaveBeenCalledWith(expect.objectContaining({
			userId: "user-1", runId: "run-2", conversationId: "conversation-1", kind: "image", mime: "image/jpeg",
			meta: expect.objectContaining({ width: 8, height: 6, source: "screenshot", sourceArtifactId: "legacy-shot" }),
		}));
		expect(onImages).toHaveBeenCalledWith({ type: "images", origin: "assistant", items: [{ artifactId: "image-1", mime: "image/jpeg", width: 8, height: 6, alt: "Captura anterior" }] });
		expect(result).toEqual(expect.objectContaining({ count: 1, remaining: 5 }));
		expect(JSON.stringify(onImages.mock.calls)).not.toContain(png.toString("base64"));
		expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
	});

	it("recusa artefato que não é imagem nem screenshot", async () => {
		loadArtifactForUser.mockResolvedValue({ id: "file-1", kind: "file", meta: {}, bytes: png });
		const onImages = vi.fn();
		await expect(executeShowImage({ source: "artifact", artifact_id: "file-1" }, { userId: "user-1", manager: { execScreenshot: vi.fn() }, getSessionId: async () => "s", remaining: 6, onImages })).rejects.toThrow("não encontrada");
		expect(onImages).not.toHaveBeenCalled();
	});

	it("preserva imagem processada sem duplicar o artefato", async () => {
		loadArtifactForUser.mockResolvedValue({ id: "processed-image", kind: "image", meta: { mime: "image/png", width: 8, height: 6 }, bytes: png });
		const onImages = vi.fn(async () => undefined);
		const result = await executeShowImage({ source: "artifact", artifact_id: "processed-image" }, { userId: "user-1", manager: { execScreenshot: vi.fn() }, getSessionId: async () => "s", remaining: 1, onImages });
		expect(persistUserArtifact).not.toHaveBeenCalled();
		expect(result.remaining).toBe(0);
		expect(onImages).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ artifactId: "processed-image" })] }));
	});

	it("recusa sétima imagem sem capturar nem emitir evento", async () => {
		const execScreenshot = vi.fn();
		const onImages = vi.fn();
		await expect(executeShowImage({ source: "screenshot" }, { userId: "user-1", manager: { execScreenshot }, getSessionId: async () => "s", remaining: 0, onImages })).rejects.toThrow("IMAGE_DISPLAY_LIMIT: limite de 6 imagens por execução; restam 0");
		expect(execScreenshot).not.toHaveBeenCalled();
		expect(onImages).not.toHaveBeenCalled();
	});

	it("recusa galeria maior que o teto", async () => {
		await expect(executeShowImage({ source: "artifact", images: Array(7).fill({ source: "artifact", artifact_id: "a" }) }, { userId: "user-1", manager: { execScreenshot: vi.fn() }, getSessionId: async () => "s", remaining: 6, onImages: vi.fn() })).rejects.toThrow("IMAGE_DISPLAY_LIMIT");
	});
});
