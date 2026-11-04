/**
 * 2ª camada do fail-closed de senha (a 1ª é a barreira na VM, `secret-field.mjs`, que lê o elemento de verdade):
 * memória por sessão da VM do que o runtime já viu. Acumula (snapshot parcial não apaga marcação), lê o ref do PRÓPRIO nó
 * (nome, rótulo e href vêm da página e não decidem nada) e só zera ao navegar. Fica em memória do processo: outra
 * instância ou retomada começa vazia, e por isso a regra de VM sem barreira declarada é "só digita em ref já visto".
 * Limitação conhecida (só VM antiga, sem barreira): "visto" se deduz de linhas que carregam texto da página, então uma
 * página pode forjar `[e7]` num texto para marcar um ref inexistente como visto. Com a barreira da VM (imagem atual) isso
 * não importa: a VM lê o elemento. Imagem antiga deve ser atualizada.
 */
const MAX_SESSIONS = 100;
const REF = "(?:f\\d{1,3})?[ea]\\d{1,5}";
/** Nome é JSON (`JSON.stringify`): aspas e barras escapadas, então o fim do literal é inequívoco. */
const NAME = '(?: "(?:[^"\\\\]|\\\\.)*")?';
/** Árvore e diff (`role "nome" [ref] ...`, `+ role ...`). */
const TREE_LINE = new RegExp(`^\\s*(?:[+\\-~]\\s+)?[A-Za-z][\\w-]*${NAME} \\[(${REF})\\]`);
/** Lista, novos elementos e busca (`[ref] role "nome" ...`, `3. [ref] role ...`). */
const LIST_LINE = new RegExp(`^\\s*(?:\\d+\\.\\s+)?\\[(${REF})\\] [A-Za-z][\\w-]*${NAME}`);
const SECRET_MARK = /\(campo de (?:senha|código de uso único)/;

export type ParsedRef = { ref: string; secret: boolean };

/** Ref do nó da linha e se a linha o marca como senha/código. `undefined` quando a linha não é de um nó com ref. */
export function parseRefLine(line: string): ParsedRef | undefined {
	const match = TREE_LINE.exec(line) ?? LIST_LINE.exec(line);
	if (!match?.[1]) return undefined;
	// A marca vem DEPOIS do nome (o servidor a anexa ao fim da linha); o nome nunca entra na checagem.
	return { ref: match[1], secret: SECRET_MARK.test(line.slice(match[0].length)) };
}

type Memory = { secret: Set<string>; seen: Set<string>; guarded: boolean };
const sessions = new Map<string, Memory>();

function memoryOf(sessionId: string): Memory {
	let memory = sessions.get(sessionId);
	if (!memory) {
		if (sessions.size >= MAX_SESSIONS) {
			const oldest = sessions.keys().next().value;
			if (oldest !== undefined) sessions.delete(oldest);
		}
		memory = { secret: new Set(), seen: new Set(), guarded: false };
		sessions.set(sessionId, memory);
	}
	return memory;
}

/** Registra os refs das linhas (snapshot, novos elementos, diff, busca, leitura). `complete`: a página inteira foi vista, então substitui. */
export function rememberLines(sessionId: string, lines: readonly string[], options: { complete?: boolean } = {}): void {
	const memory = memoryOf(sessionId);
	if (options.complete) {
		memory.secret.clear();
		memory.seen.clear();
	}
	for (const line of lines) {
		const parsed = parseRefLine(line);
		if (!parsed) continue;
		memory.seen.add(parsed.ref);
		if (parsed.secret) memory.secret.add(parsed.ref);
	}
}

/** A resposta da VM declarou a barreira (`secretGuard`). Só sobe: uma vez declarada, vale para a sessão. */
export function noteSecretGuard(sessionId: string, declared: boolean | undefined): void {
	if (declared === true) memoryOf(sessionId).guarded = true;
}

export type TypeableCheck = { ok: true } | { ok: false; reason: "secret" | "unseen" };

/** Pode digitar neste ref? Marcado como senha/código: nunca. VM sem barreira declarada: só ref já visto num snapshot. */
export function checkTypeable(sessionId: string, ref: string): TypeableCheck {
	const memory = sessions.get(sessionId);
	if (memory?.secret.has(ref)) return { ok: false, reason: "secret" };
	if (memory?.guarded) return { ok: true };
	return memory?.seen.has(ref) ? { ok: true } : { ok: false, reason: "unseen" };
}

/** Depois de navegar os refs antigos morreram (a barreira declarada da VM continua valendo). */
export function forgetRefs(sessionId: string): void {
	const memory = sessions.get(sessionId);
	if (!memory) return;
	memory.secret.clear();
	memory.seen.clear();
}

/** Só para testes: zera tudo, inclusive a barreira declarada. */
export function resetRefMemory(sessionId: string): void {
	sessions.delete(sessionId);
}
