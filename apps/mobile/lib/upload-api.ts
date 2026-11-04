// Upload de anexo ao escolher: `POST /v1/uploads/images` (imagem) ou `/v1/uploads/files` (resto), multipart com o campo
// `file`. Sem `content-type` à mão: o fetch monta o boundary. Separado de `json()` do chat-api, que força JSON.
import type { AttachmentRoute } from "./attachments";
import type { ApiFetch } from "./home-sync";

export class UploadError extends Error {
	constructor(readonly status: number | null) {
		super(status === null ? "network" : `upload ${status}`);
	}
}

export type UploadInput = { uri: string; name: string; mime: string };
export type UploadedAttachment = { id: string; width?: number; height?: number };

export const uploadPath = (route: AttachmentRoute): string => (route === "image" ? "/v1/uploads/images" : "/v1/uploads/files");

export async function uploadAttachment(apiFetch: ApiFetch, route: AttachmentRoute, input: UploadInput, signal?: AbortSignal): Promise<UploadedAttachment> {
	const form = new FormData();
	// Forma do React Native para arquivo local: o fetch lê `uri` e monta a parte do multipart.
	form.append("file", { uri: input.uri, name: input.name, type: input.mime });
	let response: Response;
	try {
		response = await apiFetch(uploadPath(route), { method: "POST", body: form, headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
	} catch (reason) {
		if (signal?.aborted) throw reason;
		throw new UploadError(null);
	}
	if (!response.ok) throw new UploadError(response.status);
	const body = (await response.json().catch(() => null)) as { id?: unknown; width?: unknown; height?: unknown } | null;
	if (!body || typeof body.id !== "string") throw new UploadError(502);
	return { id: body.id, ...(typeof body.width === "number" ? { width: body.width } : {}), ...(typeof body.height === "number" ? { height: body.height } : {}) };
}
