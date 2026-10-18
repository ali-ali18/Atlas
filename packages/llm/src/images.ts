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
			"HTTP-Referer": "https://github.com/ali-ali18/agent-bot",
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
	if (!response.ok) throw new Error(`Geração de imagem falhou (HTTP ${response.status}).`);
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
