import { loadArtifactForUser } from "@workspace/db";
import { deckImageIds, type SlideInput } from "@workspace/shared";
import { processImageForStorage } from "../../images/process.js";

/** Imagem pronta para o slide: bytes já reencodados (sem EXIF) e dimensões para manter a proporção. */
export type DeckImage = { data: string; width: number; height: number };

export type DeckImageSource = {
	userId: string;
	conversationId?: string;
	attachments?: {
		list: () => Promise<Array<{ id: string; filename: string }>>;
		bytes: (id: string) => Promise<Uint8Array | null>;
	};
	loadArtifact?: typeof loadArtifactForUser;
};

/**
 * Resolve os ids de imagem dos slides. Só entram anexos da conversa e imagens do próprio usuário
 * (geradas ou anexadas): nunca URL, então não há fetch de rede no servidor (SSRF).
 */
export async function resolveDeckImages(slides: SlideInput[], source: DeckImageSource): Promise<Map<string, DeckImage>> {
	const out = new Map<string, DeckImage>();
	const ids = deckImageIds(slides);
	if (ids.length === 0) return out;
	const attachments = source.attachments ? await source.attachments.list().catch(() => []) : [];
	const load = source.loadArtifact ?? loadArtifactForUser;
	for (const id of ids) {
		let bytes: Uint8Array | null = null;
		if (attachments.some((a) => a.id === id) && source.attachments) {
			bytes = await source.attachments.bytes(id).catch(() => null);
		} else {
			const artifact = await load(id, source.userId).catch(() => null);
			const sameConversation = !source.conversationId || !artifact?.conversationId || artifact.conversationId === source.conversationId;
			if (artifact && artifact.kind === "image" && sameConversation) bytes = new Uint8Array(artifact.bytes);
		}
		if (!bytes) {
			throw new Error(`Image ${id} was not found in this conversation. Use the id of an attached image or of one made with generate_image, or drop the image layout.`);
		}
		try {
			const processed = await processImageForStorage(bytes);
			out.set(id, { data: `${processed.mime};base64,${processed.bytes.toString("base64")}`, width: processed.width, height: processed.height });
		} catch (error) {
			throw new Error(`Image ${id} could not be used in a slide: ${error instanceof Error ? error.message : "unreadable image"}.`);
		}
	}
	return out;
}
