/** Base oficial do OpenCode Go (documentação: opencode.ai/docs/go). */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/v1";

export type GoProtocol = "chat" | "messages" | "responses" | "google";

const ENDPOINT_PATH: Record<Exclude<GoProtocol, "google">, string> = {
	chat: "/chat/completions",
	messages: "/messages",
	responses: "/responses",
};

/** Metadado do `/models` que declara o protocolo, quando existir; senão `null`. */
export function protocolFromMetadata(meta: unknown): GoProtocol | null {
	if (!meta || typeof meta !== "object") return null;
	const record = meta as Record<string, unknown>;
	for (const key of ["protocol", "api", "api_type", "api_format", "format", "endpoint", "sdk", "npm", "type"]) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const text = value.toLowerCase();
		if (text.includes("responses")) return "responses";
		if (text.includes("anthropic") || text.includes("messages")) return "messages";
		if (text.includes("google") || text.includes("gemini")) return "google";
		if (text.includes("openai-compatible") || text.includes("completions") || text.includes("chat")) return "chat";
	}
	return null;
}

/** Tabela de prefixos da documentação, usada quando o `/models` não diz o protocolo. */
export function protocolFromSlug(slug: string): GoProtocol {
	const id = slug.toLowerCase();
	if (id.startsWith("gemini-")) return "google";
	if (id.startsWith("grok-") || id.startsWith("gpt-") || id.startsWith("muse-")) return "responses";
	if (id.startsWith("claude-") || id.startsWith("minimax-") || id.startsWith("qwen3")) return "messages";
	return "chat";
}

export function goProtocolFor(slug: string, meta?: unknown): GoProtocol {
	return protocolFromMetadata(meta) ?? protocolFromSlug(slug);
}

/** URL do endpoint do protocolo; `google` não é suportado ainda. */
export function goEndpointUrl(protocol: GoProtocol, baseUrl: string = OPENCODE_GO_BASE_URL): string {
	if (protocol === "google") throw new RangeError("Protocolo Google do OpenCode Go não suportado");
	return `${baseUrl.replace(/\/+$/, "")}${ENDPOINT_PATH[protocol]}`;
}
