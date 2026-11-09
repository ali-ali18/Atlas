// Texto do comando no cartão de aprovação (`riskFacts`). Comando longo não pode ser cortado em silêncio: o dono aprova o que
// vê, então o final (onde costuma estar o efeito, ex.: `&& rm -rf …`) também aparece e o corte é anunciado com a contagem.
import { redactSecrets } from "@workspace/shared";

/** Até aqui o comando aparece inteiro. */
const PREVIEW_FULL_CHARS = 1_200;
const PREVIEW_HEAD_CHARS = 600;
const PREVIEW_TAIL_CHARS = 400;

export function commandPreview(cmd: string): string {
	// Redige antes de cortar: um segredo partido no meio do corte apareceria pela metade.
	const redacted = redactSecrets(cmd);
	if (redacted.length <= PREVIEW_FULL_CHARS) return redacted;
	const omitted = redacted.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS;
	return `${redacted.slice(0, PREVIEW_HEAD_CHARS)}… (+${omitted} caracteres) …${redacted.slice(-PREVIEW_TAIL_CHARS)}`;
}
