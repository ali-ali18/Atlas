import { describe, expect, it } from "vitest";
import type { ApiFetch } from "./home-sync";
import { uploadAttachment, UploadError, uploadPath } from "./upload-api";

const input = { uri: "file:///cache/a.jpg", name: "a.jpg", mime: "image/jpeg" };

function fake(status: number, payload: unknown) {
	const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
	const apiFetch: ApiFetch = async (path, init) => {
		calls.push({ path, init });
		return new Response(JSON.stringify(payload), { status });
	};
	return { apiFetch, calls };
}

describe("uploadAttachment", () => {
	it("roteia por tipo e manda multipart sem content-type à mão", async () => {
		expect(uploadPath("image")).toBe("/v1/uploads/images");
		expect(uploadPath("file")).toBe("/v1/uploads/files");
		const { apiFetch, calls } = fake(201, { id: "art1", width: 640, height: 480 });
		const result = await uploadAttachment(apiFetch, "image", input);
		expect(result).toEqual({ id: "art1", width: 640, height: 480 });
		expect(calls[0]!.path).toBe("/v1/uploads/images");
		expect(calls[0]!.init?.method).toBe("POST");
		expect(calls[0]!.init?.body).toBeInstanceOf(FormData);
		expect(JSON.stringify(calls[0]!.init?.headers)).not.toContain("content-type");
	});
	it("arquivo devolve só o id", async () => {
		const { apiFetch } = fake(201, { id: "f1", name: "a.pdf", mime: "application/pdf", size: 3, kind: "pdf", url: "/x" });
		expect(await uploadAttachment(apiFetch, "file", input)).toEqual({ id: "f1" });
	});
	it.each([413, 415, 429])("status %i vira UploadError com o status", async (status) => {
		const { apiFetch } = fake(status, { error: "JSON body exceeds 1 MiB" });
		await expect(uploadAttachment(apiFetch, "file", input)).rejects.toMatchObject({ status });
	});
	it("queda de rede vira UploadError sem status; resposta sem id vira 502", async () => {
		const down: ApiFetch = async () => {
			throw new TypeError("Network request failed");
		};
		await expect(uploadAttachment(down, "file", input)).rejects.toBeInstanceOf(UploadError);
		await expect(uploadAttachment(down, "file", input)).rejects.toMatchObject({ status: null });
		await expect(uploadAttachment(fake(201, {}).apiFetch, "file", input)).rejects.toMatchObject({ status: 502 });
	});
	it("cancelado pelo usuário repassa o aborto (não vira erro de rede)", async () => {
		const controller = new AbortController();
		const aborting: ApiFetch = async () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		};
		await expect(uploadAttachment(aborting, "file", input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
});
