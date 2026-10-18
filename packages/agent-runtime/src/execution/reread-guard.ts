/**
 * Guarda de releitura de `artifact_read` (A3): o modelo relia o mesmo artefato
 * em ciclos de páginas (88 decisões, nenhuma novidade). Conta as páginas lidas
 * por artefato; com o artefato TODO lido, reler a mesma página no run devolve
 * um aviso curto (ok:true, sem conteúdo) que não conta como novidade.
 * Estado por run, em memória: uma retomada recomeça a contagem (só deixa de
 * avisar, nunca bloqueia).
 */

import { ARTIFACT_READ_PAGE_CHARS } from "../tools/artifact-read.js";

export const REREAD_NOTICE_PREFIX = "Already read at step";

export function rereadNotice(step: number): string {
	return `${REREAD_NOTICE_PREFIX} ${step + 1}; use what you have.`;
}

export function isRereadNotice(text: string): boolean {
	return text.startsWith(REREAD_NOTICE_PREFIX);
}

type ArtifactReads = {
	total?: number;
	/** Intervalos [início, fim) já lidos por página. */
	ranges: Array<[number, number]>;
	/** chave da página → passo da primeira leitura. */
	pages: Map<string, number>;
};

export type RereadGuard = ReturnType<typeof createRereadGuard>;

const RANGE_RESULT = /^artifact:\S+\s+characters\s+(\d+)-(\d+)\s+of\s+(\d+)/;

function covers(ranges: Array<[number, number]>, total: number): boolean {
	let at = 0;
	for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
		if (start > at) return false;
		at = Math.max(at, end);
	}
	return at >= total;
}

function pageKey(args: Record<string, unknown>): { id: string; key: string } | null {
	let id = typeof args.id === "string" ? args.id.trim() : "";
	if (!id) return null;
	// Normalize: strip leading "artifact:" prefix if present
	if (id.startsWith("artifact:")) {
		id = id.slice(9);
	}
	const offset = Number.isInteger(Number(args.offset)) ? Number(args.offset) : 0;
	const find = typeof args.find === "string" ? args.find.trim().toLowerCase().slice(0, 200) : "";
	// Normalize: omitted length defaults to ARTIFACT_READ_PAGE_CHARS
	const length = Number.isInteger(Number(args.length)) ? Number(args.length) : ARTIFACT_READ_PAGE_CHARS;
	return { id, key: `${offset}|${length}|${find}` };
}

export function createRereadGuard() {
	const artifacts = new Map<string, ArtifactReads>();

	return {
		/** Aviso no lugar da releitura, ou null (ler normalmente). */
		check(args: Record<string, unknown>): string | null {
			const page = pageKey(args);
			if (!page) return null;
			const reads = artifacts.get(page.id);
			if (!reads || reads.total === undefined || !covers(reads.ranges, reads.total)) return null;
			const firstStep = reads.pages.get(page.key);
			return firstStep === undefined ? null : rereadNotice(firstStep);
		},

		/** Registra uma leitura que deu certo (só páginas com conteúdo contam). */
		record(args: Record<string, unknown>, resultText: string, step: number): void {
			const page = pageKey(args);
			if (!page) return;
			const reads = artifacts.get(page.id) ?? { ranges: [], pages: new Map<string, number>() };
			artifacts.set(page.id, reads);
			if (!reads.pages.has(page.key)) reads.pages.set(page.key, step);
			const match = RANGE_RESULT.exec(resultText);
			if (!match) return;
			reads.total = Number(match[3]);
			reads.ranges.push([Number(match[1]), Number(match[2])]);
		},
	};
}
