import { describe, expect, it } from "vitest";
import { ChatApiError } from "./chat-api";
import { FileTooLargeError } from "./file-api";
import { TimeoutError } from "./with-timeout";
import { IMAGE_NOTICE, imageDownloadErrorText, saveOutcomeText } from "./image-actions";

describe("imageDownloadErrorText", () => {
	it("traduz sessão, imagem apagada e erro do servidor", () => {
		expect(imageDownloadErrorText(new ChatApiError("x", 401))).toBe(IMAGE_NOTICE.expired);
		expect(imageDownloadErrorText(new ChatApiError("x", 404))).toBe(IMAGE_NOTICE.gone);
		expect(imageDownloadErrorText(new ChatApiError("x", 500))).toBe(IMAGE_NOTICE.prepareFailed);
	});
	it("imagem grande demais e rede têm frases próprias", () => {
		expect(imageDownloadErrorText(new FileTooLargeError(10))).toBe(IMAGE_NOTICE.tooLarge);
		expect(imageDownloadErrorText(new TypeError("Network request failed"))).toBe(IMAGE_NOTICE.offline);
	});
	it("tempo esgotado tem frase própria", () => {
		expect(imageDownloadErrorText(new TimeoutError(30_000))).toBe(IMAGE_NOTICE.slow);
	});
	it("nunca vaza texto técnico do erro", () => {
		expect(imageDownloadErrorText(new ChatApiError("ECONNRESET stack…", 502))).not.toMatch(/ECONNRESET/);
	});
});

describe("saveOutcomeText", () => {
	it("salvo mostra o aviso curto; negado e indisponível explicam", () => {
		expect(saveOutcomeText("saved")).toBe("Imagem salva");
		expect(saveOutcomeText("denied")).toBe(IMAGE_NOTICE.denied);
		expect(saveOutcomeText("unavailable")).toBe(IMAGE_NOTICE.saveUnavailable);
	});
});
