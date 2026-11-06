/**
 * "Doctor" semanal da memória (Motor v4, F5.3): relatório curto do estado da memória e do caderno. Funções puras.
 * Duplicatas e itens velhos saem de regra determinística; conflitos vêm do modelo do sono, e o código só aceita o que
 * cita ids que existem. O resultado é SEMPRE proposta: o doctor nunca apaga nem edita nada sozinho.
 */
import { z } from "zod";
import { normalizeForDedupe, wordOverlap } from "./proactive.js";
import type { DoctorFinding } from "./sleep.js";

/** Sem atualização há tanto tempo, o item é apontado como velho (proposta; o dono decide). */
export const DOCTOR_STALE_DAYS = 180;
/** Dois textos com ao menos esta sobreposição de palavras (e 4+ palavras cada) são "muito parecidos". */
export const DOCTOR_SIMILAR_OVERLAP = 0.85;
export const DOCTOR_MIN_WORDS = 4;
export const DOCTOR_MAX_FINDINGS_PER_TYPE = 20;
export const DOCTOR_REASON_MAX_CHARS = 240;

export type DoctorMemoryItem = { id: string; /** Camada/escopo: itens de camadas diferentes nunca se comparam. */ scope: string; content: string; updatedAt: Date | string; validUntil?: Date | string | null };
export type DoctorNoteItem = { id: string; scope: string; title: string; body: string; updatedAt: Date | string };

const wordCount = (text: string) => normalizeForDedupe(text).split(" ").filter((word) => word.length > 2).length;
const time = (value: Date | string) => new Date(value).getTime();

function duplicatesOf(items: ReadonlyArray<{ id: string; scope: string; text: string }>, subject: DoctorFinding["subject"]): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const claimed = new Set<string>();
	for (let i = 0; i < items.length; i += 1) {
		const a = items[i]!;
		if (claimed.has(a.id)) continue;
		for (let j = i + 1; j < items.length; j += 1) {
			const b = items[j]!;
			if (claimed.has(b.id) || a.scope !== b.scope) continue;
			const same = normalizeForDedupe(a.text) === normalizeForDedupe(b.text) && normalizeForDedupe(a.text).length > 0;
			const similar = !same && wordCount(a.text) >= DOCTOR_MIN_WORDS && wordCount(b.text) >= DOCTOR_MIN_WORDS && wordOverlap(a.text, b.text) >= DOCTOR_SIMILAR_OVERLAP;
			if (!same && !similar) continue;
			claimed.add(a.id);
			claimed.add(b.id);
			findings.push({ type: "duplicate", subject, ids: [a.id, b.id], reason: same ? "Os dois textos dizem a mesma coisa." : "Os dois textos são muito parecidos." });
			break;
		}
		if (findings.length >= DOCTOR_MAX_FINDINGS_PER_TYPE) break;
	}
	return findings;
}

/** Duplicatas e itens velhos da memória e do caderno. Determinístico: o mesmo estado dá o mesmo relatório. */
export function analyzeMemoryHealth(input: { memory: readonly DoctorMemoryItem[]; notes: readonly DoctorNoteItem[]; now: Date }): DoctorFinding[] {
	const staleBefore = input.now.getTime() - DOCTOR_STALE_DAYS * 24 * 60 * 60 * 1000;
	const findings: DoctorFinding[] = [
		...duplicatesOf(input.memory.map((item) => ({ id: item.id, scope: item.scope, text: item.content })), "memory"),
		...duplicatesOf(input.notes.map((note) => ({ id: note.id, scope: note.scope, text: `${note.title} ${note.body}` })), "note"),
	];
	const stale: DoctorFinding[] = [];
	for (const item of input.memory) {
		if (item.validUntil && time(item.validUntil) < input.now.getTime()) stale.push({ type: "stale", subject: "memory", ids: [item.id], reason: "A validade deste item já passou." });
		else if (time(item.updatedAt) < staleBefore) stale.push({ type: "stale", subject: "memory", ids: [item.id], reason: `Sem mudança há mais de ${DOCTOR_STALE_DAYS} dias.` });
	}
	for (const note of input.notes) if (time(note.updatedAt) < staleBefore) stale.push({ type: "stale", subject: "note", ids: [note.id], reason: `Sem mudança há mais de ${DOCTOR_STALE_DAYS} dias.` });
	return [...findings, ...stale.slice(0, DOCTOR_MAX_FINDINGS_PER_TYPE * 2)];
}

const conflictSchema = z.object({ subject: z.enum(["memory", "note"]), ids: z.array(z.string().trim().min(1).max(64)).min(2).max(6), reason: z.string().trim().min(1).max(DOCTOR_REASON_MAX_CHARS) });

/**
 * Conflitos propostos pelo modelo. Só vale o que cita 2+ ids que existem NO MESMO conjunto (memória ou caderno) que o
 * código mostrou ao modelo; o resto é descartado, nunca "consertado". `validIds` são os ids enviados.
 */
export function parseConflictFindings(raw: unknown, validIds: { memory: ReadonlySet<string>; note: ReadonlySet<string> }): DoctorFinding[] {
	const list = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).conflicts : undefined;
	if (!Array.isArray(list)) return [];
	const out: DoctorFinding[] = [];
	for (const item of list) {
		const parsed = conflictSchema.safeParse(item);
		if (!parsed.success) continue;
		const ids = [...new Set(parsed.data.ids)];
		if (ids.length < 2 || !ids.every((id) => validIds[parsed.data.subject].has(id))) continue;
		out.push({ type: "conflict", subject: parsed.data.subject, ids, reason: parsed.data.reason });
		if (out.length >= DOCTOR_MAX_FINDINGS_PER_TYPE) break;
	}
	return out;
}

/** Resumo de uma frase para o dono (pt-BR, sem nome interno). Sem achado, diz que está tudo em ordem. */
export function doctorSummary(findings: readonly DoctorFinding[]): string {
	if (findings.length === 0) return "A memória e o caderno estão em ordem esta semana.";
	const count = (type: DoctorFinding["type"]) => findings.filter((finding) => finding.type === type).length;
	const parts = [
		[count("duplicate"), "repetido", "repetidos"],
		[count("conflict"), "que se contradiz", "que se contradizem"],
		[count("stale"), "velho", "velhos"],
	] as const;
	const text = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
	return `Achei ${text.join(", ")}. Nada foi apagado: você decide o que fazer.`;
}
