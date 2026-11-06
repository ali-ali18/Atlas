// Run de agenda (F4.3, lado do agente): o que o modelo recebe ao acordar e a política do run. O item vem do banco já
// com a permissão decidida na criação (`grant`): o run NÃO tem dono para perguntar, então a superfície é `agenda`
// (sem enviar, pagar, publicar nem escrever fora) e o que precisar do dono vira `pending` no resultado.
//
// Texto que vai ao MODELO: inglês, curto. A nota e o memo foram escritos pelo próprio modelo no passado (a partir do que o dono
// pediu): entram escapados, nunca como instrução do sistema. Remetente e assunto do evento são dado de terceiro (canal `data`).
import type { AgendaEvent, AgendaKind } from "@workspace/shared";
import { escapeReserved } from "../channels/escape.js";
import type { ChannelInput } from "../channels/envelope.js";
import type { PolicyContext } from "../contract/authorize.js";

export type AgendaWakeItem = {
	kind: AgendaKind;
	note: string;
	runCount: number;
	maxRuns: number | null;
	untilAt: Date | null;
	/** O que o run anterior deixou para este (`memo` do `agenda_result`). */
	lastMemo?: string | null;
	lastResultAt?: Date | null;
	grant: { autonomy: PolicyContext["autonomy"]; rules: PolicyContext["rules"] } | null;
};

/** Política do run de agenda: sem dono, na autonomia decidida na criação (padrão `balanced`). */
export function agendaRunPolicy(grant: AgendaWakeItem["grant"]): PolicyContext {
	return { surface: "agenda", ownerPresent: false, autonomy: grant?.autonomy ?? "balanced", rules: grant?.rules ?? [] };
}

/** "2026-11-05 09:00" no fuso do dono. */
function localStamp(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

const KIND_GUIDE: Readonly<Record<AgendaKind, string>> = {
	remind: "This is a reminder. Write it as a short message to the owner and finish with agenda_result update carrying that message.",
	watch: "This is a quiet watch. Check what the note says. If nothing relevant changed, finish with no_change and remember what you saw in memo. If it changed, finish with update. If the job is finished, finish with done.",
	intent: "An event the owner asked about arrived. Do what the note says about it, then finish with agenda_result (update with a message if there is something to tell, no_change if the event did not need anything).",
	brief: "Prepare the owner's brief from what the note asks for, then finish with agenda_result update carrying it.",
};

export function buildAgendaWake(input: { item: AgendaWakeItem; now: Date; timeZone: string; event?: AgendaEvent }): { history: ChannelInput[] } {
	const { item } = input;
	const run = item.maxRuns !== null ? `${item.runCount} of ${item.maxRuns}` : `${item.runCount}`;
	const lines = [
		"Agenda wake. You scheduled this earlier. The owner is not here: nothing you write as plain text reaches them.",
		`Kind: ${item.kind} | Run ${run} | Now: ${localStamp(input.now, input.timeZone)} (${input.timeZone})${item.untilAt ? ` | Ends: ${localStamp(item.untilAt, input.timeZone)}` : ""}`,
		`Your note: ${escapeReserved(item.note)}`,
		...(item.lastMemo ? [`Memo from the last run${item.lastResultAt ? ` (${localStamp(item.lastResultAt, input.timeZone)})` : ""}: ${escapeReserved(item.lastMemo)}`] : []),
		KIND_GUIDE[item.kind],
		"End with agenda_result exactly once. no_change = nothing new: the owner hears nothing. update = news: message is what they read, in their language. done = finished: the item ends.",
		"If something needs the owner (an approval, a missing detail), finish what you can, then use update and list it in pending. Do not wait for an answer and do not ask.",
		"Sending, paying, publishing and writing to outside systems are not available in this run.",
	];
	const history: ChannelInput[] = [{ kind: "runtime", text: lines.join("\n") }];
	if (input.event) history.push({ kind: "data", source: input.event.source, text: `From: ${input.event.from}\nSubject: ${input.event.subject}\nAttachment: ${input.event.hasAttachment ? "yes" : "no"}` });
	return { history };
}
