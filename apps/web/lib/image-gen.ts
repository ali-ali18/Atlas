/** Placeholder ao vivo do `generate_image`: leitura da chamada e troca/limpeza do cartão. */
import type { Message } from "@/components/ui/templates/template-4/data";
import { activeT } from "@/lib/i18n/active";

export type ImageGenMessage = Extract<Message, { kind: "image-gen" }>;

const RATIO = /^(\d{1,2}):(\d{1,2})$/;

/** Proporção pedida ("16:9") ou 1:1 quando ausente/inválida. */
export function normalizeAspectRatio(value: unknown): string {
	if (typeof value !== "string") return "1:1";
	const match = RATIO.exec(value.trim());
	if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) return "1:1";
	return `${Number(match[1])}:${Number(match[2])}`;
}

export function aspectRatioValue(ratio: string): number {
	const match = RATIO.exec(ratio);
	return match ? Number(match[1]) / Number(match[2]) : 1;
}

export function parseGenerateImageCall(args: string): { count: 1 | 2; aspectRatio: string } {
	try {
		const parsed = JSON.parse(args) as { n?: unknown; aspect_ratio?: unknown };
		return { count: parsed.n === 2 ? 2 : 1, aspectRatio: normalizeAspectRatio(parsed.aspect_ratio) };
	} catch {
		return { count: 1, aspectRatio: "1:1" };
	}
}

export function imageGenCardId(callId: string): string {
	return `image-gen-${callId}`;
}

/** As imagens chegaram: o cartão em andamento mais recente dá lugar a elas, na mesma posição. */
export function replacePendingWithImages(previous: Message[], images: Message): Message[] {
	if (previous.some((item) => item.id === images.id)) return previous;
	let index = -1;
	for (let i = previous.length - 1; i >= 0; i--) {
		const item = previous[i];
		if (item?.kind === "image-gen" && item.status === "running") {
			index = i;
			break;
		}
	}
	if (index < 0) return previous;
	return [...previous.slice(0, index), images, ...previous.slice(index + 1)];
}

/** Resultado da tool: falha vira estado de erro no mesmo cartão; sucesso sem imagem (ex.: pedido de confirmação) remove o cartão. */
export function settleImageGen(previous: Message[], callId: string, result: { ok: boolean; summary: string }): Message[] {
	const id = imageGenCardId(callId);
	if (!previous.some((item) => item.id === id)) return previous;
	if (result.ok) return previous.filter((item) => item.id !== id);
	return previous.map((item) => item.id === id && item.kind === "image-gen" ? { ...item, status: "error", error: friendlyImageError(result.summary) } : item);
}

/** Fim do run (concluído, cancelado ou com erro): nenhum cartão fica "gerando". */
export function clearRunningImageGen(previous: Message[]): Message[] {
	return previous.some((item) => item.kind === "image-gen" && item.status === "running")
		? previous.filter((item) => !(item.kind === "image-gen" && item.status === "running"))
		: previous;
}

function friendlyImageError(summary: string): string {
	const text = summary.replace(/^Error:\s*/i, "").trim();
	return text ? text.slice(0, 200) : activeT("errors.generateImage");
}
