export const IMAGE_GENERATION_TIMEOUT_MS = 120_000;

export type GenerateImagesParams = {
	apiKey: string;
	model: string;
	prompt: string;
	n: number;
	aspectRatio?: string;
	resolution?: string;
	inputReferences?: string[];
	signal?: AbortSignal;
	fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type GeneratedImage = { bytes: Buffer; mime: string };

export type GenerateImagesResult = {
	images: GeneratedImage[];
	costUsd?: number;
	/** true quando o provider não informou o custo (não é zero). */
	costUnknown?: boolean;
};

export async function generateImages(params: GenerateImagesParams): Promise<GenerateImagesResult> {
	if (!params.apiKey || !params.model || !params.prompt.trim() || !Number.isInteger(params.n) || params.n < 1 || params.n > 2) {
		throw new Error("Parâmetros de geração de imagem inválidos.");
	}
	const signal = AbortSignal.any([
		...(params.signal ? [params.signal] : []),
		AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
	]);
	const response = await (params.fetchFn ?? fetch)("https://openrouter.ai/api/v1/images", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
			"X-Title": "Atlas",
		},
		body: JSON.stringify({
			model: params.model,
			prompt: params.prompt,
			n: params.n,
			...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
			...(params.resolution ? { resolution: params.resolution } : {}),
			...(params.inputReferences ? { input_references: params.inputReferences } : {}),
		}),
		signal,
	});
	if (!response.ok) {
		// Modelo que gera imagem só pelo chat (saída "image"+"text", ex.: Gemini/GPT image): o endpoint
		// /images recusa (4xx) antes de cobrar; tenta uma vez pelo chat. 5xx nunca repete (evita cobrança dupla).
		if ([400, 404, 405, 415, 422].includes(response.status)) return generateImagesViaChat(params, signal);
		throw new Error(await failureMessage(response));
	}
	const body: unknown = await response.json();
	if (!body || typeof body !== "object") throw new Error("Resposta de geração de imagem inválida.");
	const value = body as { data?: unknown; usage?: { cost?: unknown } };
	if (!Array.isArray(value.data) || value.data.length === 0 || value.data.length > params.n) {
		throw new Error("Resposta de geração de imagem sem imagens válidas.");
	}
	const images = value.data.map((entry: unknown): GeneratedImage => {
		if (!entry || typeof entry !== "object") throw new Error("Imagem gerada inválida.");
		const image = entry as { b64_json?: unknown; media_type?: unknown };
		if (typeof image.b64_json !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json)) {
			throw new Error("Imagem gerada inválida.");
		}
		const mime = image.media_type ?? "image/png";
		if (typeof mime !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(mime)) {
			throw new Error("Tipo de imagem gerada inválido.");
		}
		return { bytes: Buffer.from(image.b64_json, "base64"), mime };
	});
	const cost = value.usage?.cost;
	return { images, ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : { costUnknown: true }) };
}


/** Mensagem curta do provedor (sem chave, sem corpo bruto) para o usuário entender a recusa. */
async function failureMessage(response: Response): Promise<string> {
	let detail = "";
	if (response.status >= 400 && response.status < 500) {
		try {
			const body = (await response.json()) as { error?: { message?: unknown } };
			const message = body?.error?.message;
			if (typeof message === "string") detail = ` ${message.replace(/\s+/g, " ").trim().slice(0, 160)}`;
		} catch {
			/* corpo não é JSON: só o status */
		}
	}
	return `Geração de imagem falhou (HTTP ${response.status}).${detail}`;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Geração pelo chat completions: `modalities: ["image","text"]`, imagens em `message.images[].image_url.url` (data URL). */
async function generateImagesViaChat(params: GenerateImagesParams, signal: AbortSignal): Promise<GenerateImagesResult> {
	const images: GeneratedImage[] = [];
	let cost = 0;
	let costKnown = true;
	for (let index = 0; index < params.n; index++) {
		const response = await (params.fetchFn ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${params.apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
				"X-Title": "Atlas",
			},
			body: JSON.stringify({
				model: params.model,
				messages: [{ role: "user", content: params.prompt }],
				modalities: ["image", "text"],
				...(params.aspectRatio ? { image_config: { aspect_ratio: params.aspectRatio } } : {}),
				usage: { include: true },
			}),
			signal,
		});
		if (!response.ok) throw new Error(await failureMessage(response));
		const body = (await response.json()) as { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: unknown } }> } }>; usage?: { cost?: unknown } };
		const found = body.choices?.[0]?.message?.images ?? [];
		if (found.length === 0) throw new Error("O modelo não devolveu imagem. Escolha um modelo de geração de imagem em Configurações › Modelos.");
		for (const entry of found) {
			const url = entry?.image_url?.url;
			const match = typeof url === "string" ? DATA_URL.exec(url) : null;
			if (!match) throw new Error("Imagem gerada inválida.");
			images.push({ bytes: Buffer.from(match[2]!, "base64"), mime: match[1]! });
		}
		const c = body.usage?.cost;
		if (typeof c === "number" && Number.isFinite(c) && c >= 0) cost += c;
		else costKnown = false;
		if (images.length >= params.n) break;
	}
	return { images: images.slice(0, params.n), ...(costKnown ? { costUsd: cost } : { costUnknown: true }) };
}
