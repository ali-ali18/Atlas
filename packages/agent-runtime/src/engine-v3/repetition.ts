/**
 * Rede contra laço do motor v3 (desenho 2.6), sem relógio. Chave = (tool, args normalizados, hash do resultado).
 * Escada: 3ª repetição idêntica = nota no próprio resultado; 5ª = a chamada não executa ("blocked: repeated");
 * 2 bloqueios no run = FINAL_STEP. Ping-pong A,B,A,B (4 ciclos) e o mesmo erro (tool+alvo+erro) 3x seguem a mesma
 * escada. Tools com `poll: true` (esperas, status de job) ficam isentas até 30 iguais seguidas.
 * Guarda pós-compactação: as 3 primeiras chamadas depois de compactar não podem repetir a última de antes (gancho para o
 * PR7, que liga a compactação; aqui só o mecanismo).
 */
export const REPEAT_NOTE_AT = 3;
export const REPEAT_BLOCK_AT = 5;
export const POLL_EXEMPT = 30;
export const BLOCKS_TO_FINAL = 2;
const PING_PONG_NOTE_CYCLES = 4;
const HISTORY_MAX = 12;
const MAP_MAX = 500;

export const REPEAT_NOTE = "[runtime] Same call and same result 3 times; change approach.";
export const PING_PONG_NOTE = "[runtime] You are alternating between the same two calls; change approach.";
export const SAME_ERROR_NOTE = "[runtime] Same error on the same target 3 times; change approach or tell the user what is blocking.";
export const COMPACTION_REPEAT_NOTE = "[runtime] This repeats the last call made before the context was compacted, with the same result. Use what you already have.";
export const BLOCKED_REPEATED = "blocked: repeated. This exact call already returned the same result several times and was not executed again. Use the result you have, try a different approach, or answer the user.";

export type RepetitionSnapshot = { blocks: number; counts: Array<[string, number]>; errors: Array<[string, number]>; history: string[] };

export type CallRecord = { argsKey: string; resultKey: string; poll: boolean; ok: boolean; errorKey?: string };

export function createRepetitionGuard(initial?: RepetitionSnapshot) {
	const counts = new Map<string, number>(initial?.counts ?? []);
	const errors = new Map<string, number>(initial?.errors ?? []);
	const history: string[] = [...(initial?.history ?? [])];
	let blocks = initial?.blocks ?? 0;
	let pollStreak = { key: "", count: 0 };
	let compaction: { key: string; remaining: number; hits: number } | undefined;
	let lastFull: string | undefined;

	const bump = (map: Map<string, number>, key: string) => {
		const next = (map.get(key) ?? 0) + 1;
		if (map.size >= MAP_MAX && !map.has(key)) map.delete(map.keys().next().value as string);
		map.set(key, next);
		return next;
	};
	/** Ciclos A,B completos no fim do histórico (A≠B), contando com `next` se vier. */
	const pingPongCycles = (list: readonly string[]) => {
		const n = list.length;
		if (n < 4) return 0;
		const a = list[n - 2]!;
		const b = list[n - 1]!;
		if (a === b) return 0;
		let length = 2;
		while (length < n && list[n - 1 - length] === (length % 2 === 0 ? b : a)) length += 1;
		return Math.floor(length / 2);
	};
	const maxCountFor = (argsKey: string) => {
		let max = 0;
		for (const [key, value] of counts) if (key.startsWith(`${argsKey}\u0000`) && value > max) max = value;
		return max;
	};

	return {
		/** Antes de executar: a 5ª repetição idêntica (ou o 5º ciclo de ping-pong, ou o 5º mesmo erro) não roda. */
		shouldBlock(input: { argsKey: string; poll: boolean; errorTarget?: string }): boolean {
			const sameCount = input.poll
				? pollStreak.key.startsWith(`${input.argsKey}\u0000`) ? pollStreak.count - (POLL_EXEMPT - REPEAT_NOTE_AT) : 0
				: maxCountFor(input.argsKey);
			const pingPong = pingPongCycles([...history, input.argsKey].slice(-HISTORY_MAX));
			let errorCount = 0;
			if (input.errorTarget) for (const [key, value] of errors) if (key.startsWith(`${input.errorTarget}\u0000`)) errorCount = Math.max(errorCount, value);
			const block = sameCount >= REPEAT_BLOCK_AT - 1 || pingPong > PING_PONG_NOTE_CYCLES || errorCount >= REPEAT_BLOCK_AT - 1;
			if (block) blocks += 1;
			return block;
		},
		/** Depois de executar: devolve as notas a anexar ao resultado e se a guarda pós-compactação pede o FINAL_STEP. */
		record(call: CallRecord): { notes: string[]; final: boolean } {
			const full = `${call.argsKey}\u0000${call.resultKey}`;
			const notes: string[] = [];
			let final = false;
			history.push(call.argsKey);
			if (history.length > HISTORY_MAX) history.shift();
			if (call.poll) {
				pollStreak = pollStreak.key === full ? { key: full, count: pollStreak.count + 1 } : { key: full, count: 1 };
				if (pollStreak.count === POLL_EXEMPT) notes.push(REPEAT_NOTE);
			} else {
				pollStreak = { key: "", count: 0 };
				if (bump(counts, full) === REPEAT_NOTE_AT) notes.push(REPEAT_NOTE);
			}
			if (pingPongCycles(history) === PING_PONG_NOTE_CYCLES) notes.push(PING_PONG_NOTE);
			if (!call.ok && call.errorKey && bump(errors, call.errorKey) === REPEAT_NOTE_AT && !notes.includes(REPEAT_NOTE)) notes.push(SAME_ERROR_NOTE);
			if (compaction && compaction.remaining > 0) {
				compaction.remaining -= 1;
				if (full === compaction.key) {
					compaction.hits += 1;
					notes.push(COMPACTION_REPEAT_NOTE);
					if (compaction.hits >= 2) final = true;
				}
			}
			lastFull = full;
			return { notes, final };
		},
		/** Gancho da compactação (PR7): a última chamada de antes vira a chave vigiada nas 3 chamadas seguintes. */
		markCompaction(): void {
			if (lastFull) compaction = { key: lastFull, remaining: 3, hits: 0 };
		},
		blocks: () => blocks,
		reachedFinal: () => blocks >= BLOCKS_TO_FINAL,
		snapshot: (): RepetitionSnapshot => ({ blocks, counts: [...counts].slice(-200), errors: [...errors].slice(-100), history: [...history] }),
	};
}

export type RepetitionGuard = ReturnType<typeof createRepetitionGuard>;
