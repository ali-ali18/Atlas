// Marcadores do composer (`@bot` e `/habilidade`), tudo puro. O TextInput do RN não aceita componente dentro do texto,
// então o marcador vive fora dele: uma lista de chips antes do texto, dentro do campo. No envio os marcadores voltam
// a ser texto, no mesmo formato do web (`apps/web/lib/mention-input.ts`, `applyMention`): `@Nome` e `/slug`, que o
// servidor lê pelas mesmas regras (`parseGroupMentions` e `parseSlashSkills` de `@workspace/shared`).
import { foldText, SLASH_SKILL_MAX } from "@workspace/shared";

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

/** Backspace com o cursor no começo do campo apaga o último marcador inteiro (fora do começo, segue no texto). */
export function backspaceRemovesMarker(selection: { start: number; end: number }, markerCount: number): boolean {
	return markerCount > 0 && selection.start === 0 && selection.end === 0;
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
