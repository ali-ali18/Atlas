import { createHash } from "node:crypto";
import type { CarriedNote } from "@workspace/shared";

/**
 * Notas de turno que definem uma tarefa em andamento (procedimento de uma skill chamada, contexto de menção)
 * valem enquanto a conversa continua nela. A conversa gravada não as leva (notas de sistema são refeitas a cada
 * run), então ficam no checkpoint e voltam nos turnos seguintes. Limites: poucas, curtas e com validade; uma
 * nota igual chamada de novo renova a validade (o mesmo conteúdo = a mesma chave); a que passa de
 * `CARRIED_NOTE_MAX_IDLE_TURNS` turnos sem ser chamada cai.
 */
export const CARRIED_NOTE_MAX_IDLE_TURNS = 6;
export const CARRIED_NOTES_MAX = 4;
export const CARRIED_NOTE_MAX_CHARS = 4_000;
export const CARRIED_NOTES_TOTAL_MAX_CHARS = 10_000;

const keyOf = (content: string) => createHash("sha1").update(content.slice(0, 200)).digest("hex").slice(0, 16);

/**
 * `prior`: notas guardadas no run anterior. `fresh`: notas deste turno (já entram no prompt). Devolve o que vai
 * para o checkpoint e as notas antigas que ainda valem e devem ser reinjetadas agora (sem as repetidas em `fresh`).
 */
export function mergeCarriedNotes(prior: readonly CarriedNote[] | undefined, fresh: readonly string[]): { carried: CarriedNote[]; reinject: CarriedNote[] } {
	const freshNotes: CarriedNote[] = fresh
		.map((content) => content.trim().slice(0, CARRIED_NOTE_MAX_CHARS))
		.filter(Boolean)
		.map((content) => ({ key: keyOf(content), content, idleTurns: 0 }));
	const freshKeys = new Set(freshNotes.map((note) => note.key));
	const reinject = (prior ?? [])
		.map((note) => ({ ...note, idleTurns: note.idleTurns + 1 }))
		.filter((note) => note.idleTurns <= CARRIED_NOTE_MAX_IDLE_TURNS && !freshKeys.has(note.key));
	let carried = [...reinject, ...freshNotes].slice(-CARRIED_NOTES_MAX);
	while (carried.length > 1 && carried.reduce((sum, note) => sum + note.content.length, 0) > CARRIED_NOTES_TOTAL_MAX_CHARS) carried = carried.slice(1);
	const kept = new Set(carried.map((note) => note.key));
	return { carried, reinject: reinject.filter((note) => kept.has(note.key)) };
}
