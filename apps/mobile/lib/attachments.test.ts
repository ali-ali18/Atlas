import { ATTACHMENT_LIMITS, IMAGE_LIMITS } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { canSendAttachments, countsOf, fileSlotsLeft, FILE_TOO_BIG_NOW, imageSlotsLeft, isUploading, patchDraft, removeDraft, routeFor, toOutgoing, toRefs, uploadErrorMessage, uploadName, validatePicked, type AttachmentDraft } from "./attachments";

const draft = (over: Partial<AttachmentDraft> = {}): AttachmentDraft => ({ key: "k1", route: "image", uri: "file:///a.jpg", name: "a.jpg", mime: "image/jpeg", status: "done", artifactId: "art1", ...over });

describe("routeFor", () => {
	it("image/* sobe pelo caminho das imagens, o resto como arquivo", () => {
		expect(routeFor("image/png")).toBe("image");
		expect(routeFor("IMAGE/JPEG")).toBe("image");
		expect(routeFor("application/pdf")).toBe("file");
		expect(routeFor(undefined)).toBe("file");
	});
});

describe("uploadName", () => {
	it("foto sem nome vira foto.jpg; HEIC convertido em JPEG ganha .jpg", () => {
		expect(uploadName(undefined, "image/jpeg", "image")).toBe("foto.jpg");
		expect(uploadName("IMG_0001.HEIC", "image/jpeg", "image")).toBe("IMG_0001.jpg");
		expect(uploadName("praia", "image/png", "image")).toBe("praia.png");
	});
	it("arquivo sem extensão ganha a do MIME; com extensão fica como está", () => {
		expect(uploadName("relatório", "application/pdf", "file")).toBe("relatório.pdf");
		expect(uploadName("planilha.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "file")).toBe("planilha.xlsx");
		expect(uploadName("dados", "application/octet-stream", "file")).toBe("dados");
	});
	it("tira caminho do nome", () => {
		expect(uploadName("../../etc/passwd", "text/plain", "file")).toBe("passwd.txt");
	});
});

describe("validatePicked", () => {
	const empty = { images: 0, files: 0 };
	it("imagem JPEG vai pela rota de imagens", () => {
		expect(validatePicked({ uri: "u", name: "a.jpg", mime: "image/jpeg", size: 1000 }, empty)).toEqual({ ok: true, route: "image", name: "a.jpg", mime: "image/jpeg" });
	});
	it("sem MIME, usa a extensão da imagem", () => {
		expect(validatePicked({ uri: "u", name: "a.png", size: 10 }, empty)).toMatchObject({ ok: true, route: "image", mime: "image/png" });
	});
	it("PDF vai como arquivo", () => {
		expect(validatePicked({ uri: "u", name: "a.pdf", mime: "application/pdf", size: 5 }, empty)).toMatchObject({ ok: true, route: "file" });
	});
	it("recusa vazio, HEIC/SVG, imagem acima de 10 MB e arquivo acima de 20 MB", () => {
		expect(validatePicked({ uri: "u", name: "a.pdf", mime: "application/pdf", size: 0 }, empty)).toMatchObject({ ok: false });
		expect(validatePicked({ uri: "u", name: "a.heic", mime: "image/heic", size: 5 }, empty)).toMatchObject({ ok: false, message: expect.stringContaining("formato não aceito") });
		expect(validatePicked({ uri: "u", name: "a.jpg", mime: "image/jpeg", size: IMAGE_LIMITS.maxBytes + 1 }, empty)).toMatchObject({ ok: false, message: expect.stringContaining("10 MB") });
		expect(validatePicked({ uri: "u", name: "a.pdf", mime: "application/pdf", size: ATTACHMENT_LIMITS.maxBytes + 1 }, empty)).toMatchObject({ ok: false, message: expect.stringContaining("20 MB") });
	});
	it("aceita exatamente no limite de tamanho", () => {
		expect(validatePicked({ uri: "u", name: "a.jpg", mime: "image/jpeg", size: IMAGE_LIMITS.maxBytes }, empty)).toMatchObject({ ok: true });
	});
	it("limita a quantidade por tipo (4 imagens, 5 arquivos), cada uma na sua conta", () => {
		const full = { images: IMAGE_LIMITS.maxPerMessage, files: 0 };
		expect(validatePicked({ uri: "u", name: "a.jpg", mime: "image/jpeg" }, full)).toMatchObject({ ok: false, message: expect.stringContaining("4 imagens") });
		expect(validatePicked({ uri: "u", name: "a.pdf", mime: "application/pdf" }, full)).toMatchObject({ ok: true });
		expect(validatePicked({ uri: "u", name: "a.pdf", mime: "application/pdf" }, { images: 0, files: ATTACHMENT_LIMITS.maxPerMessage })).toMatchObject({ ok: false, message: expect.stringContaining("5 arquivos") });
	});
});

describe("vagas e lista de rascunhos", () => {
	it("conta vagas que restam", () => {
		const drafts = [draft(), draft({ key: "k2", route: "file", mime: "application/pdf", name: "a.pdf" })];
		expect(countsOf(drafts)).toEqual({ images: 1, files: 1 });
		expect(imageSlotsLeft(countsOf(drafts))).toBe(3);
		expect(fileSlotsLeft(countsOf(drafts))).toBe(4);
	});
	it("envio só com tudo pronto: subindo e erro bloqueiam", () => {
		expect(canSendAttachments([])).toBe(true);
		expect(canSendAttachments([draft()])).toBe(true);
		expect(canSendAttachments([draft(), draft({ key: "k2", status: "uploading" })])).toBe(false);
		expect(canSendAttachments([draft({ status: "error" })])).toBe(false);
		expect(isUploading([draft({ status: "uploading" })])).toBe(true);
	});
	it("patch e remove por chave", () => {
		const list = [draft(), draft({ key: "k2" })];
		expect(patchDraft(list, "k2", { status: "error" })[1]!.status).toBe("error");
		expect(removeDraft(list, "k1").map((item) => item.key)).toEqual(["k2"]);
	});
	it("toOutgoing leva só os prontos; toRefs só os ids, imagens e arquivos juntos", () => {
		const list = [draft({ width: 800, height: 600 }), draft({ key: "k2", route: "file", name: "a.pdf", mime: "application/pdf", artifactId: "art2", size: 12 }), draft({ key: "k3", status: "uploading", artifactId: undefined })];
		const out = toOutgoing(list);
		expect(out.map((item) => item.artifactId)).toEqual(["art1", "art2"]);
		expect(out[0]).toMatchObject({ width: 800, height: 600 });
		expect(toRefs(out)).toEqual([{ artifactId: "art1" }, { artifactId: "art2" }]);
	});
});

describe("uploadErrorMessage", () => {
	it("traduz 413, 415, 429 e queda de rede em pt-BR", () => {
		expect(uploadErrorMessage(413, "file")).toBe(FILE_TOO_BIG_NOW);
		expect(uploadErrorMessage(413, "image")).toContain("10 MB");
		expect(uploadErrorMessage(415, "file")).toContain("não é aceito");
		expect(uploadErrorMessage(429, "file")).toContain("Espere");
		expect(uploadErrorMessage(null, "file")).toContain("Sem conexão");
		expect(uploadErrorMessage(500, "image")).toContain("Tente de novo");
	});
});
