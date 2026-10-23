/**
 * Tamanho do JSON do array de tools (`JSON.stringify(tools).length`) sem serializar o array a cada
 * passo: o tamanho de cada definição fica memorizado pelo objeto. As definições não são mutadas
 * (trocar uma tool troca o objeto), então o total só muda quando o conjunto muda.
 */
const toolJsonChars = new WeakMap<object, number>();

export function toolsJsonCharsOf(tools: readonly object[]): number {
	// `[` + `]` + vírgulas entre os itens: igual ao `JSON.stringify` do array.
	let total = 2 + Math.max(0, tools.length - 1);
	for (const tool of tools) {
		let chars = toolJsonChars.get(tool);
		if (chars === undefined) {
			chars = JSON.stringify(tool).length;
			toolJsonChars.set(tool, chars);
		}
		total += chars;
	}
	return total;
}
