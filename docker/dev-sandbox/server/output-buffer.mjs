// Buffer de saída com teto: guarda o começo (HEAD) e uma janela circular do
// fim (TAIL). Offsets são bytes lógicos desde o início do processo, então o
// cliente lê incrementalmente (`since`) e detecta o que foi descartado.

export const RETURN_CAP_BYTES = 64 * 1024;

export function createOutputBuffer({ maxBytes = 1024 * 1024 } = {}) {
	let chunks = []; // { start, text }
	let total = 0; // bytes lógicos escritos
	let kept = 0; // bytes retidos
	let dropped = 0; // bytes descartados do começo

	return {
		append(text) {
			if (!text) return;
			const bytes = Buffer.byteLength(text);
			chunks.push({ start: total, text, bytes });
			total += bytes;
			kept += bytes;
			while (kept > maxBytes && chunks.length > 1) {
				const first = chunks.shift();
				kept -= first.bytes;
				dropped += first.bytes;
			}
		},
		get total() {
			return total;
		},
		get dropped() {
			return dropped;
		},
		/** Texto a partir do offset lógico `since`, até `cap` bytes (mantém o FIM). */
		read(since = 0, cap = RETURN_CAP_BYTES) {
			const from = Math.max(0, since);
			const joined = chunks.map((c) => c.text).join("");
			const base = dropped;
			let buf = Buffer.from(joined, "utf8");
			const skipped = Math.max(0, from - base);
			if (skipped > 0) buf = buf.subarray(Math.min(skipped, buf.length));
			const lostBefore = from < base ? base - from : 0;
			let truncated = lostBefore > 0;
			let omitted = lostBefore;
			if (buf.length > cap) {
				omitted += buf.length - cap;
				buf = buf.subarray(buf.length - cap);
				truncated = true;
			}
			const text = buf.toString("utf8").replace(/^�+/, "");
			return { text, nextOffset: total, truncated, omittedBytes: omitted };
		},
	};
}

/** Nota padrão quando parte da saída foi cortada (mantemos o final: o erro costuma estar lá). */
export function truncationNote(omittedBytes) {
	return `[... ${omittedBytes} bytes iniciais omitidos; redirecione a saída para um arquivo e leia por trechos ...]\n`;
}

/** Corta uma string em `cap` bytes mantendo o fim, com a nota na frente. */
export function capTail(text, cap = RETURN_CAP_BYTES) {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= cap) return { text, truncated: false, omittedBytes: 0 };
	const omittedBytes = buf.length - cap;
	const tail = buf.subarray(buf.length - cap).toString("utf8").replace(/^�+/, "");
	return { text: truncationNote(omittedBytes) + tail, truncated: true, omittedBytes };
}
