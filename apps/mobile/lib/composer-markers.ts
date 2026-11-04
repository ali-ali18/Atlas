// Marcadores do composer (`@bot` e `/habilidade`), tudo puro. O TextInput do RN não aceita componente dentro do texto,
// então o marcador vive fora dele: uma lista de chips antes do texto, dentro do campo. No envio os marcadores voltam
// a ser texto, no mesmo formato do web (`apps/web/lib/mention-input.ts`, `applyMention`): `@Nome` e `/slug`, que o
// servidor lê pelas mesmas regras (`parseGroupMentions` e `parseSlashSkills` de `@workspace/shared`).
import { foldText, parseSlashSkills, SLASH_SKILL_MAX } from "@workspace/shared";

export type BotMarker = { kind: "bot"; id: string; name: string; color?: string; shape?: string };
export type SkillMarker = { kind: "skill"; id: string; /** Nome em slug: o que `/habilidade` carrega. */ name: string };
export type Marker = BotMarker | SkillMarker;

/** O texto do marcador como o web escreve: `@Nome` (nome inteiro, com espaço e acento) ou `/slug`. */
export function markerToken(marker: Marker): string {
	return `${marker.kind === "bot" ? "@" : "/"}${marker.name.trim()}`;
}

const sameMarker = (a: Marker, b: Marker) => a.kind === b.kind && a.id === b.id;

/**
 * Põe o marcador no fim da lista. Repetido não entra, e habilidade além de `SLASH_SKILL_MAX` também não (o servidor
 * só lê esse tanto por mensagem).
 */
export function addMarker(markers: readonly Marker[], marker: Marker): Marker[] {
	if (!marker.name.trim() || markers.some((item) => sameMarker(item, marker))) return [...markers];
	if (marker.kind === "skill" && markers.filter((item) => item.kind === "skill").length >= SLASH_SKILL_MAX) return [...markers];
	return [...markers, marker];
}

export function removeMarker(markers: readonly Marker[], marker: Marker): Marker[] {
	return markers.filter((item) => !sameMarker(item, marker));
}

/**
 * Sentinela invisível: com marcadores no campo, o valor do TextInput começa com ele (`fieldValue`). Apagar o primeiro
 * caractere do campo (backspace com o cursor no começo) apaga o sentinela, e isso o `onChangeText` enxerga em qualquer
 * teclado (o `onKeyPress` do Android não vem de forma confiável). Ele nunca entra no texto guardado, no rascunho nem no envio.
 */
export const SENTINEL = "\u200B";

/** O que o TextInput mostra: o texto, com o sentinela na frente quando há marcadores. */
export function fieldValue(markerCount: number, text: string): string {
	return markerCount > 0 ? SENTINEL + text : text;
}

/** Quantos caracteres do campo são o sentinela (para converter a seleção do campo na do texto e de volta). */
export const fieldOffset = (markerCount: number): number => (markerCount > 0 ? 1 : 0);

/**
 * O campo mudou: devolve o texto sem sentinela e se o sentinela sumiu (com marcadores, é o backspace no começo: apaga o
 * último marcador). Sentinela que só mudou de lugar (texto digitado antes dele) não conta como apagado.
 */
export function readFieldChange(value: string, markerCount: number): { text: string; removeLast: boolean } {
	return { text: value.split(SENTINEL).join(""), removeLast: markerCount > 0 && !value.includes(SENTINEL) };
}

/** Limite total de uma mensagem (igual ao `maxLength` antigo do campo). */
export const MESSAGE_MAX = 20_000;

/** Quanto o campo ainda aceita: o limite da mensagem menos o que os marcadores ocupam no envio (`@Nome /slug `). */
export function fieldMaxLength(markers: readonly Marker[], total = MESSAGE_MAX): number {
	if (markers.length === 0) return total;
	// `composeMessage(markers, "x")` = marcadores + espaço + "x".
	return Math.max(0, total - (composeMessage(markers, "x").length - 1));
}

/** Habilidades já na mensagem (chips e `/slug` escritos no texto, fora o gatilho aberto) bateram o limite do servidor? */
export function skillsFull(markers: readonly Marker[], textWithoutTrigger: string): boolean {
	const inText = parseSlashSkills(textWithoutTrigger).length;
	return markers.filter((item) => item.kind === "skill").length + inText >= SLASH_SKILL_MAX;
}

/**
 * O texto que vai ao servidor: os marcadores (`@Nome /slug`) e depois o que foi digitado, separados por um espaço.
 * Só marcador também envia (no web `@Nome` sozinho é texto). Vazio devolve "".
 */
export function composeMessage(markers: readonly Marker[], text: string): string {
	const typed = text.trim();
	return [...markers.map(markerToken), ...(typed ? [typed] : [])].join(" ");
}

/** Há o que enviar? (texto ou ao menos um marcador). */
export function hasContent(markers: readonly Marker[], text: string): boolean {
	return markers.length > 0 || text.trim().length > 0;
}

function endsToken(value: string, length: number): boolean {
	return length >= value.length || /\s/.test(value[length]!);
}

/** Quantos caracteres de `value` (sem diferenciar caixa nem acento) formam exatamente `foldedName`; 0 se não casa. */
function matchedLength(value: string, foldedName: string): number {
	for (let length = 1; length <= value.length; length += 1) {
		const folded = foldText(value.slice(0, length));
		if (folded === foldedName) return endsToken(value, length) ? length : 0;
		if (folded.length > foldedName.length) return 0;
	}
	return 0;
}

/**
 * Lê os marcadores do começo de um texto (rascunho que já chega escrito, ou texto reenviado): `@Nome` de um bot
 * conhecido (nome com espaço e acento, sem diferenciar caixa) e `/slug` de uma habilidade conhecida, em fila, cada um
 * seguido de espaço ou do fim. Devolve os marcadores e o resto. O que não for conhecido fica no texto.
 */
export function splitLeadingMarkers(
	text: string,
	bots: readonly Omit<BotMarker, "kind">[],
	skills: readonly { id: string; name: string }[],
): { markers: Marker[]; rest: string } {
	let markers: Marker[] = [];
	// Nomes mais longos primeiro: "Ana Maria" vence "Ana".
	const botsByLength = bots.filter((bot) => bot.name.trim()).sort((a, b) => b.name.trim().length - a.name.trim().length);
	let rest = text.replace(/^\s+/, "");
	for (;;) {
		let next: Marker | null = null;
		let used = 0;
		if (rest.startsWith("@")) {
			for (const bot of botsByLength) {
				const length = matchedLength(rest.slice(1), foldText(bot.name.trim()));
				if (length > 0) {
					next = { kind: "bot", ...bot, name: bot.name.trim() };
					used = 1 + length;
					break;
				}
			}
		} else if (rest.startsWith("/")) {
			const word = /^\/([a-z0-9][a-z0-9-]*)/.exec(rest)?.[1];
			const skill = word ? skills.find((item) => item.name === word) : undefined;
			if (skill && word && endsToken(rest, 1 + word.length)) {
				next = { kind: "skill", id: skill.id, name: skill.name };
				used = 1 + word.length;
			}
		}
		if (!next) break;
		const added = addMarker(markers, next);
		if (added.length === markers.length) break;
		markers = added;
		rest = rest.slice(used).replace(/^\s+/, "");
	}
	return { markers, rest };
}

/**
 * Rascunho que começava com `/slug` e só agora tem as habilidades: converte o começo do texto atual em chips, somando
 * aos que já existem, e devolve o que sobra do texto (o que a pessoa digitou depois fica) e quantos caracteres saíram dele.
 */
export function adoptLeadingMarkers(
	markers: readonly Marker[],
	text: string,
	bots: readonly Omit<BotMarker, "kind">[],
	skills: readonly { id: string; name: string }[],
): { markers: Marker[]; text: string; consumed: number } {
	const split = splitLeadingMarkers(text, bots, skills);
	if (split.markers.length === 0) return { markers: [...markers], text, consumed: 0 };
	let merged = [...markers];
	for (const marker of split.markers) merged = addMarker(merged, marker);
	return { markers: merged, text: split.rest, consumed: text.length - split.rest.length };
}
