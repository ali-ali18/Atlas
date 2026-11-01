/**
 * Motor v2: notas de sistema por origem (modo proativo no chat, rotina "só importante", alerta, evento de
 * configuração do bot). São os MESMOS textos do v1, injetados como mensagens de sistema extras logo depois do
 * prompt principal e só no run que precisa: o prompt do chat comum não cresce. Texto para o modelo, em inglês.
 */
import { buildProactiveChatPromptSection, type ChatMessage, type ProactiveSettings } from "@workspace/shared";
import { USER_PUSH_ROUTINE_NOTE, getBotConfigEventExtraSystemMessage } from "../computer-use.js";
import type { UserPushMode } from "../tools/proactive.js";
import { alertRunNote, type AlertRunState } from "../tools/report-alert.js";

export function originSystemNotes(input: {
	origin: string;
	messages: ChatMessage[];
	proactive?: { settings: ProactiveSettings } | null;
	userPushMode?: UserPushMode | null;
	alertRun?: AlertRunState | null;
}): string[] {
	const notes: Array<string | null> = [
		input.proactive && input.origin === "chat" ? buildProactiveChatPromptSection(input.proactive.settings) : null,
		input.userPushMode === "routine" ? USER_PUSH_ROUTINE_NOTE : null,
		input.alertRun ? alertRunNote(input.alertRun) : null,
		getBotConfigEventExtraSystemMessage(input.messages),
	];
	return notes.filter((note): note is string => Boolean(note));
}
