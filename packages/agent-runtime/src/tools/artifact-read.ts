import type { ChatTool } from "@workspace/llm";

/**
 * `artifact_read` (L3): relê um resultado grande de tool guardado por referência
 * (o id vem do stub no contexto) em páginas, ou procura um trecho nele. Sem `id`,
 * mantém o comportamento antigo (lista os screenshots capturados no run).
 *
 * Escopo: o artefato é do dono da sessão E (do run em andamento OU de outro run
 * da mesma conversa). O id vem do modelo, nunca é confiável. Outro dono, outra
 * conversa ou inexistente responde "não encontrado", sem revelar que o id existe.
 */
export const ARTIFACT_READ_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "artifact_read",
		description:
			"Reads a large tool result that was stored by reference (use the artifact id shown in the result). Pass offset to page through it, or find to search inside it. Without id, lists the screenshots captured in this run. Use it instead of repeating the original tool call.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Artifact id from the stored-result line." },
				offset: { type: "integer", description: "First character to read (default 0)." },
				length: { type: "integer", description: "Characters to read (1-8000, default 8000)." },
				find: { type: "string", description: "Text to search for (case-insensitive); returns the matches with their offsets." },
			},
		},
	},
};

export const ARTIFACT_READ_PAGE_CHARS = 8_000;
const FIND_MAX_MATCHES = 6;
const FIND_WINDOW_CHARS = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const STORED_RESULT_NOT_FOUND =
	"Stored result not found for this run. Use the artifact id exactly as shown in the stored-result line.";

export type StoredArtifact = { kind: string; runId: string | null; bytes: Uint8Array };

function integerArg(value: unknown, name: string, min: number, max: number, fallback: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

function processTextRead(id: string, text: string, offset: number, length: number, find: string): string {
	if (find) {
		const needle = find.toLowerCase();
		const haystack = text.toLowerCase();
		const matches: string[] = [];
		let from = Math.min(offset, text.length);
		while (matches.length < FIND_MAX_MATCHES) {
			const at = haystack.indexOf(needle, from);
			if (at < 0) break;
			const start = Math.max(0, at - FIND_WINDOW_CHARS / 2);
			const end = Math.min(text.length, at + needle.length + FIND_WINDOW_CHARS / 2);
			matches.push(`@${at}: ${text.slice(start, end).replace(/\s+/g, " ")}`);
			from = end;
		}
		if (matches.length === 0) return `artifact:${id} (${text.length} chars): no match for "${find}" from offset ${offset}.`;
		return `artifact:${id} (${text.length} chars): ${matches.length} match(es) for "${find}" (offsets are character positions; read around one with offset).\n${matches.join("\n")}`;
	}

	if (offset >= text.length) return `artifact:${id} (${text.length} chars): offset ${offset} is past the end; nothing more to read.`;
	const end = Math.min(text.length, offset + length);
	const next = end < text.length ? ` Next: artifact_read with id "${id}" and offset ${end}.` : " End of the stored result.";
	return `artifact:${id} characters ${offset}-${end} of ${text.length}.${next}\n${text.slice(offset, end)}`;
}

export async function readStoredResult(
	args: Record<string, unknown>,
	ctx: {
		userId?: string;
		runId?: string;
		conversationId?: string;
		load: (artifactId: string, userId: string) => Promise<StoredArtifact | null>;
		loadFromConversation?: (artifactId: string, userId: string, conversationId: string) => Promise<StoredArtifact | null>;
	},
): Promise<string> {
	let id = typeof args.id === "string" ? args.id.trim() : "";
	// Strip leading "artifact:" prefix if present
	if (id.startsWith("artifact:")) {
		id = id.slice(9);
	}
	if (!ID_PATTERN.test(id)) throw new Error("id is required and must be an artifact id from a stored-result line");
	const offset = integerArg(args.offset, "offset", 0, 50_000_000, 0);
	const length = integerArg(args.length, "length", 1, ARTIFACT_READ_PAGE_CHARS, ARTIFACT_READ_PAGE_CHARS);
	const find = typeof args.find === "string" ? args.find.trim().slice(0, 200) : "";
	if (!ctx.userId || ctx.userId === "default" || !ctx.runId) throw new Error(STORED_RESULT_NOT_FOUND);

	// Tenta carregar do run atual primeiro
	let artifact = await ctx.load(id, ctx.userId).catch(() => null);
	if (artifact && artifact.kind === "tool_result" && artifact.runId === ctx.runId) {
		const text = new TextDecoder("utf-8").decode(artifact.bytes);
		return processTextRead(id, text, offset, length, find);
	}

	// Se não encontrou no run atual, tenta da mesma conversa (runs anteriores)
	if (ctx.conversationId && ctx.loadFromConversation) {
		artifact = await ctx.loadFromConversation(id, ctx.userId, ctx.conversationId).catch(() => null);
		if (artifact && artifact.kind === "tool_result") {
			const text = new TextDecoder("utf-8").decode(artifact.bytes);
			return processTextRead(id, text, offset, length, find);
		}
	}

	throw new Error(STORED_RESULT_NOT_FOUND);
}
