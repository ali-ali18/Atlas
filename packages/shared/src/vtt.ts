/**
 * Legenda WebVTT -> texto corrido. Função pura (sem I/O): o formato é lido por blocos e por
 * caracteres, sem regex sobre o conteúdo. Serve a `video_transcript`, que baixa a legenda na VM.
 */

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
	["&nbsp;", " "],
	["&lt;", "<"],
	["&gt;", ">"],
	["&quot;", '"'],
	["&#39;", "'"],
	["&apos;", "'"],
	// `&amp;` por último: "&amp;lt;" vira "&lt;" (texto literal), não "<".
	["&amp;", "&"],
];

/** Tira marcas inline (`<c>`, `<00:00:01.000>`, `<i>`) e decodifica as entidades comuns. */
export function stripVttTags(line: string): string {
	let out = "";
	const chars = [...line];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] as string;
		if (ch === "<") {
			// `<` sem `>` depois é texto ("a < b"), não marca: só pula quando a marca fecha.
			const close = chars.indexOf(">", i + 1);
			// Outro `<` antes do `>`: este é texto solto e o `>` é da marca seguinte ("a < b <i>").
			const nextOpen = chars.indexOf("<", i + 1);
			if (close >= 0 && (nextOpen < 0 || nextOpen > close)) {
				i = close;
				continue;
			}
		}
		out += ch;
	}
	for (const [entity, value] of ENTITIES) out = out.split(entity).join(value);
	return out.split(/\s+/).filter(Boolean).join(" ");
}

const SKIPPED_BLOCKS = ["WEBVTT", "NOTE", "STYLE", "REGION", "Kind:", "Language:"];

export type ParsedVtt = {
	/** Linhas de fala, na ordem, sem tempo, sem marca e sem as repetições das legendas automáticas roladas. */
	lines: string[];
	/** `lines` unidas por espaço. */
	text: string;
	/** Quantos cues tinham texto (antes de remover as repetições). */
	cues: number;
};

/**
 * Legenda automática do YouTube repete a segunda linha de um cue como primeira do seguinte (e
 * ainda tem cues curtos só com a linha repetida). Linha igual à última emitida é descartada;
 * repetição não adjacente (um refrão, "[Música]" duas vezes) é fala de verdade e fica.
 */
export function parseVtt(vtt: string): ParsedVtt {
	const lines: string[] = [];
	let cues = 0;
	const blocks = vtt.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/);
	for (const block of blocks) {
		const rows = block.split(/\r?\n/);
		const head = (rows[0] ?? "").trim();
		if (SKIPPED_BLOCKS.some((prefix) => head.startsWith(prefix))) continue;
		const timing = rows.findIndex((row) => row.includes("-->"));
		if (timing < 0) continue;
		let hadText = false;
		for (const row of rows.slice(timing + 1)) {
			const text = stripVttTags(row);
			if (!text) continue;
			hadText = true;
			if (lines[lines.length - 1] !== text) lines.push(text);
		}
		if (hadText) cues += 1;
	}
	return { lines, text: lines.join(" "), cues };
}
