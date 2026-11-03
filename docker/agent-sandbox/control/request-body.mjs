// Corpo das requisições do control server: teto de bytes (413) e JSON inválido (400), sem derrubar o processo.
export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
	const declared = Number(req.headers?.["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, `request body too large (max ${maxBytes} bytes)`);
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new HttpError(413, `request body too large (max ${maxBytes} bytes)`);
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
}
