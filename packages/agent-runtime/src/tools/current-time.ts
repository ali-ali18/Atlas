import type { ChatTool } from "@workspace/llm";
import { isValidTimeZone } from "@workspace/shared";
import { localClock, resolveNoteTimeZone } from "../context/today-note.js";

/**
 * `current_time`: relógio local do usuário, sem LLM e sem rede. A hora já vai em cada pedido como contexto
 * automático; a tool existe para run longo (o contexto pode estar velho), prazos e conta de agendamento.
 * Fica no grupo lazy `routines` (agendar e prazos são o uso): sempre carregada custaria ~100 tokens por pedido
 * (o teto do prefixo do "Bom dia" estoura); a hora aproximada já vem em todo pedido.
 */
export const CURRENT_TIME_TOOL_NAME = "current_time";

export const CURRENT_TIME_TOOL: ChatTool = {
	type: "function",
	function: {
		name: CURRENT_TIME_TOOL_NAME,
		description: "Current local date and time. Use in long runs (context time may be stale), for deadlines or scheduling math. Do not call it when the message already carries the current time.",
		parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA zone; default: the user's" } } },
	},
};

function offsetOf(now: Date, timeZone: string): string {
	const raw = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
	return raw === "GMT" ? "+00:00" : raw.replace("GMT", "");
}

export function executeCurrentTime(args: Record<string, unknown>, context: { now: Date; timeZone?: string | null }): { summary: string } {
	const asked = args.timezone;
	if (asked !== undefined && asked !== null && asked !== "") {
		if (typeof asked !== "string" || !isValidTimeZone(asked)) {
			throw new Error(`Invalid timezone "${String(asked).slice(0, 60)}". Use an IANA name such as America/Sao_Paulo, or omit it for the user's timezone.`);
		}
	}
	const timeZone = typeof asked === "string" && asked ? asked : resolveNoteTimeZone(context.timeZone);
	const clock = localClock(context.now, timeZone);
	const seconds = new Intl.DateTimeFormat("en-GB", { timeZone, second: "2-digit" }).format(context.now).padStart(2, "0");
	const iso = `${clock.date}T${clock.time}:${seconds}${offsetOf(context.now, timeZone)}`;
	return { summary: `${clock.date} ${clock.time} (${clock.weekday}), timezone ${timeZone}. ISO: ${iso}` };
}
