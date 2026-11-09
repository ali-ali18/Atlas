// Busca de posições em texto extraído de um anexo (função pura, sem I/O). Serve a leitura em partes do modelo: o achado
// só mostra onde está o trecho; nada aqui decide o comportamento do agente.

/** Posições (caractere) onde `needle` aparece em `text`, sem diferenciar maiúsculas, a partir de `from`, até `max` achados. */
export function findTextPositions(text: string, needle: string, from: number, max: number): number[] {
	if (!needle) return [];
	const hay = text.toLowerCase();
	const wanted = needle.toLowerCase();
	const positions: number[] = [];
	let cursor = Math.max(0, Math.min(from, text.length));
	while (positions.length < max) {
		const at = hay.indexOf(wanted, cursor);
		if (at < 0) break;
		positions.push(at);
		cursor = at + wanted.length;
	}
	return positions;
}
