import { parseConversationCard } from "./skill-card.js";

/** Imagem de usuário de um turno anterior, já filtrada pelo dono quando vem do db. */
export type HistoryImageItem = { artifactId: string; name?: string };

/**
 * Imagens que o usuário anexou a UMA mensagem de usuário do histórico.
 * `missing` guarda os nomes das que não puderam ser anexadas (não são do dono,
 * sumiram): servem só para a linha de aviso ao modelo.
 */
export type HistoryImageGroup = { userText: string; items: HistoryImageItem[]; missing: string[] };

type Row = { role: string; content: string };

/**
 * Casa cada cartão `images` de origem "user" com a mensagem de usuário que o
 * precede (o anexo é persistido logo depois do texto). Pura: o dono é checado
 * depois, no db, antes de qualquer id virar `image_ref`.
 */
export function groupUserImageRows(rows: readonly Row[]): HistoryImageGroup[] {
	const groups: HistoryImageGroup[] = [];
	let lastUser: string | null = null;
	for (const row of rows) {
		if (row.role === "user") {
			lastUser = row.content;
			continue;
		}
		if (row.role !== "images" || lastUser === null) continue;
		const card = parseConversationCard(row.content);
		if (card?.kind !== "images" || card.origin !== "user") continue;
		groups.push({
			userText: lastUser,
			items: card.items.map((item) => ({ artifactId: item.artifactId, ...(item.name ? { name: item.name } : {}) })),
			missing: [],
		});
		lastUser = null;
	}
	return groups;
}

type Part = { type: string; [key: string]: unknown };
type Msg = { role: string; content: unknown };

const MAX_PER_MESSAGE = 4;

function namesOf(names: string[]): string {
	return names.map((name) => name.replace(/[\r\n\[\]]/g, " ").slice(0, 60)).join(", ");
}

/**
 * Devolve o histórico com as imagens de turnos anteriores anexadas como
 * `image_ref` à mensagem de usuário a que pertencem (o casamento é pelo texto,
 * do mais recente para o mais antigo). `excludeIds` são as do pedido atual,
 * que o runtime já anexa à última mensagem. O que não puder ser anexado vira
 * uma linha neutra, para o modelo nunca dizer que "não recebeu anexo".
 */
export function attachHistoryImages<M extends Msg>(
	messages: readonly M[],
	groups: readonly HistoryImageGroup[],
	excludeIds: readonly string[] = [],
	maxPerMessage = MAX_PER_MESSAGE,
): M[] {
	if (groups.length === 0) return [...messages];
	const excluded = new Set(excludeIds);
	const out = [...messages];
	let cursor = out.length - 1;
	for (let g = groups.length - 1; g >= 0; g--) {
		const group = groups[g]!;
		let index = -1;
		for (let i = cursor; i >= 0; i--) {
			const message = out[i]!;
			if (message.role === "user" && typeof message.content === "string" && message.content.trim() === group.userText.trim()) {
				index = i;
				break;
			}
		}
		if (index < 0) continue;
		cursor = index - 1;
		if (group.items.length > 0 && group.items.every((item) => excluded.has(item.artifactId))) continue;
		const message = out[index]!;
		const text = message.content as string;
		const attached = group.items.filter((item) => !excluded.has(item.artifactId)).slice(0, maxPerMessage);
		const attachedIds = new Set(attached.map((item) => item.artifactId));
		const unattached = [
			...group.missing,
			...group.items.filter((item) => !excluded.has(item.artifactId) && !attachedIds.has(item.artifactId)).map((item) => item.name ?? "image"),
		];
		const note = unattached.length > 0
			? `\n[An earlier message included ${unattached.length} user image(s) (${namesOf(unattached)}); they are not attached now.]`
			: "";
		if (attached.length === 0 && !note) continue;
		const parts: Part[] = [{ type: "text", text: `${text}${note}` }];
		for (const item of attached) parts.push({ type: "image_ref", artifactId: item.artifactId, ...(item.name ? { name: item.name } : {}) });
		out[index] = { ...message, content: attached.length > 0 ? parts : `${text}${note}` };
	}
	return out;
}
