import { describe, expect, it } from "vitest";
import type { ApiFetch } from "./home-sync";
import { uploadAttachment, UploadError, uploadPath, type ToBlobPart } from "./upload-api";

const part: ToBlobPart = (file) => new Blob(["x"], { type: file.mime });
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
		const result = await uploadAttachment(apiFetch, "image", input, part);
		expect(result).toEqual({ id: "art1", width: 640, height: 480 });
		expect(calls[0]!.path).toBe("/v1/uploads/images");
		expect(calls[0]!.init?.method).toBe("POST");
		expect(calls[0]!.init?.body).toBeInstanceOf(FormData);
		expect(JSON.stringify(calls[0]!.init?.headers)).not.toContain("content-type");
	});
	it("a parte do multipart é Blob com o nome (e extensão) do anexo, nunca {uri}", async () => {
		const seen: unknown[] = [];
		const spy: ToBlobPart = (file) => {
			seen.push(file);
			return part(file);
		};
		const { apiFetch, calls } = fake(201, { id: "art1" });
		await uploadAttachment(apiFetch, "image", input, spy);
		expect(seen).toEqual([input]);
		const sent = (calls[0]!.init?.body as FormData).get("file") as File;
		expect(sent).toBeInstanceOf(Blob);
		expect(sent.name).toBe("a.jpg");
		expect(sent.type).toBe("image/jpeg");
	});
	it("arquivo devolve só o id", async () => {
		const { apiFetch } = fake(201, { id: "f1", name: "a.pdf", mime: "application/pdf", size: 3, kind: "pdf", url: "/x" });
		expect(await uploadAttachment(apiFetch, "file", input, part)).toEqual({ id: "f1" });
	});
	it.each([413, 415, 429])("status %i vira UploadError com o status", async (status) => {
		const { apiFetch } = fake(status, { error: "JSON body exceeds 1 MiB" });
		await expect(uploadAttachment(apiFetch, "file", input, part)).rejects.toMatchObject({ status });
	});
	it("queda de rede vira UploadError sem status; resposta sem id vira 502", async () => {
		const down: ApiFetch = async () => {
			throw new TypeError("Network request failed");
		};
		await expect(uploadAttachment(down, "file", input, part)).rejects.toBeInstanceOf(UploadError);
		await expect(uploadAttachment(down, "file", input, part)).rejects.toMatchObject({ status: null });
		await expect(uploadAttachment(fake(201, {}).apiFetch, "file", input, part)).rejects.toMatchObject({ status: 502 });
	});
	it("cancelado pelo usuário repassa o aborto (não vira erro de rede)", async () => {
		const controller = new AbortController();
		const aborting: ApiFetch = async () => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		};
		await expect(uploadAttachment(aborting, "file", input, part, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
});
