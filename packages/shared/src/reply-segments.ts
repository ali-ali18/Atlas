// Divide a resposta do assistente em bolhas (uma por parágrafo), mas nunca
// dentro de um bloco de código cercado: linhas em branco ali fazem parte do código.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

export function splitReplySegments(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const segments: string[] = [];
	let current: string[] = [];
	let blanks = 0;
	let fence: { char: string; len: number } | null = null;

	const flush = () => {
		const segment = current.join("\n").trim();
		if (segment.length > 0) segments.push(segment);
		current = [];
	};

	for (const line of lines) {
		if (fence) {
			current.push(line);
			const close = FENCE_OPEN.exec(line);
			if (
				close &&
				close[1]![0] === fence.char &&
				close[1]!.length >= fence.len &&
				line.trim() === close[1]
			) {
				fence = null;
			}
			continue;
		}
		if (line.trim().length === 0) {
			blanks++;
			continue;
		}
		// 2+ quebras de linha seguidas = pelo menos 1 linha em branco entre parágrafos.
		if (blanks >= 1) flush();
		blanks = 0;
		const open = FENCE_OPEN.exec(line);
		if (open) {
			const marker = open[1]!;
			// Cerca de crase não aceita crase no info string (CommonMark).
			if (!(marker[0] === "`" && line.slice(open[0].length).includes("`"))) {
				fence = { char: marker[0]!, len: marker.length };
			}
		}
		current.push(line);
	}
	flush();
	return segments;
}
