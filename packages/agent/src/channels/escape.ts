// Escape determinístico de tudo que NÃO vem do runtime (fala do dono, resultado
// de tool, e-mail, página, arquivo, MCP, outro bot).
//
// Por que existe: o canal é marcado por tags no texto. Sem escape, uma página ou
// o próprio usuário poderia escrever `</data>` para sair do bloco de dado, ou
// `<atlas:runtime id="…">` para se passar pelo sistema (o `[runtime]` do v3 era
// forjável assim). Isto é sanitização de FORMATO, não decisão de comportamento:
// não olha a intenção do texto, só neutraliza a sequência reservada. A defesa
// principal continua sendo o nonce (o atacante não o conhece); o escape fecha o
// resto, inclusive o escape do bloco de dado.
//
// Regra: todo `<` (ou parecido: ＜ ﹤ ‹ 〈 ⟨ ❮) seguido, ignorando espaço, caracteres
// invisíveis (zero-width etc.) e variantes de largura/caixa, de `atlas`, `/atlas`,
// `data` ou `/data` vira `&lt;`. Pode neutralizar a mais (`<database`): o custo é
// só estético e o texto sem sequência reservada sai byte a byte igual.

const OPENERS = new Set(["<", "＜", "﹤", "‹", "〈", "⟨", "❮", "≺"]);
const SKIPPABLE = /[\s\p{Cf}]/u;
const LOOKAHEAD = 48;

function startsReserved(text: string, from: number): boolean {
	// Junta os próximos caracteres úteis (sem espaço/invisível), normaliza largura e caixa.
	let collected = "";
	for (let i = from; i < text.length && collected.length < LOOKAHEAD; ) {
		const cp = text.codePointAt(i) as number;
		const ch = String.fromCodePoint(cp);
		i += ch.length;
		if (SKIPPABLE.test(ch)) continue;
		collected += ch;
		if (collected.length >= 8) break;
	}
	let norm = collected.normalize("NFKC").toLowerCase();
	if (norm.startsWith("/") || norm.startsWith("⁄") || norm.startsWith("∕")) norm = norm.slice(1);
	return norm.startsWith("atlas") || norm.startsWith("data");
}

export function escapeReserved(text: string): string {
	let out = "";
	let last = 0;
	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i) as number;
		const ch = String.fromCodePoint(cp);
		if (OPENERS.has(ch) && startsReserved(text, i + ch.length)) {
			out += `${text.slice(last, i)}&lt;`;
			last = i + ch.length;
		}
		i += ch.length;
	}
	return last === 0 ? text : out + text.slice(last);
}
