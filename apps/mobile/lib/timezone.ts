// Fuso horário: aparelho, lista pesquisável e a decisão do "automático". Funções puras; o módulo nativo só entra em
// `deviceTimeZone` (com require tardio, para os testes não carregarem o expo-localization).
import { isValidTimeZone } from "@workspace/shared";

/** Fusos mais usados por quem fala português: a lista de partida quando o motor não sabe listar todos. */
const FALLBACK_ZONES = [
	"America/Sao_Paulo",
	"America/Manaus",
	"America/Fortaleza",
	"America/Bahia",
	"America/Belem",
	"America/Cuiaba",
	"America/Campo_Grande",
	"America/Rio_Branco",
	"America/Noronha",
	"America/Argentina/Buenos_Aires",
	"America/Bogota",
	"America/Mexico_City",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"Atlantic/Azores",
	"Europe/Lisbon",
	"Europe/London",
	"Europe/Madrid",
	"Europe/Paris",
	"Europe/Berlin",
	"Africa/Luanda",
	"Africa/Maputo",
	"Asia/Dubai",
	"Asia/Kolkata",
	"Asia/Tokyo",
	"Australia/Sydney",
	"UTC",
];

/** Fuso do aparelho (IANA), ou `null` se não der para saber. */
export function deviceTimeZone(): string | null {
	try {
		const calendars = (require("expo-localization") as typeof import("expo-localization")).getCalendars();
		const zone = calendars[0]?.timeZone;
		if (zone && isValidTimeZone(zone)) return zone;
	} catch {
		// módulo nativo indisponível: tenta o Intl
	}
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimeZone(zone) ? zone : null;
	} catch {
		return null;
	}
}

/** Todos os fusos que o motor lista (ordem alfabética, `UTC` sempre presente); sem `Intl.supportedValuesOf`, a lista de partida. */
export function listTimeZones(): string[] {
	let zones: string[] = [];
	try {
		const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
		zones = supported ? supported("timeZone") : [];
	} catch {
		zones = [];
	}
	return withExtras(zones.length > 0 ? zones : FALLBACK_ZONES);
}

/** Garante `UTC` e os fusos pedidos (o da conta e o do aparelho nunca somem da lista), sem repetir, em ordem. */
export function withExtras(zones: readonly string[], ...extras: (string | null | undefined)[]): string[] {
	const all = new Set(zones);
	all.add("UTC");
	for (const extra of extras) if (extra && isValidTimeZone(extra)) all.add(extra);
	return [...all].sort((a, b) => a.localeCompare(b));
}

/** Nomes IANA vêm sem acento; estes ganham o acento em português. */
const ACCENTED: Readonly<Record<string, string>> = { "Sao Paulo": "São Paulo", Belem: "Belém", Cuiaba: "Cuiabá", Maceio: "Maceió", Santarem: "Santarém", "Sao Tome": "São Tomé", Asuncion: "Asunción", Bogota: "Bogotá", Cancun: "Cancún", Merida: "Mérida" };

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export function timeZoneCity(zone: string): string {
	const last = (zone.split("/").pop() ?? zone).replace(/_/g, " ");
	return ACCENTED[last] ?? last;
}

/** "GMT-3" no fuso, ou "" se o motor não calcula. */
export function timeZoneOffset(zone: string, now: Date): string {
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "";
	} catch {
		return "";
	}
}

/** "São Paulo (GMT-3)": cidade e deslocamento de agora (`now` injetado). */
export function timeZoneLabel(zone: string, now: Date): string {
	const offset = timeZoneOffset(zone, now);
	return offset ? `${timeZoneCity(zone)} (${offset})` : timeZoneCity(zone);
}

const normalize = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Busca por cidade, região ou id, sem acento nem caixa ("sao paulo", "buenos", "america"). Sem busca devolve tudo. */
export function filterTimeZones(zones: readonly string[], rawQuery: string): string[] {
	const query = normalize(rawQuery);
	if (!query) return [...zones];
	return zones.filter((zone) => normalize(`${zone.replace(/[/_]/g, " ")} ${timeZoneCity(zone)}`).includes(query));
}

/**
 * O fuso está em automático? A escolha explícita do dono (guardada no aparelho) vence; sem escolha, vale a inferência:
 * conta sem fuso ou com o mesmo do aparelho está seguindo o aparelho (quem já escolheu outro à mão no web não é sobrescrito).
 */
export function isAutoTimezone(choice: boolean | null, accountZone: string | null, device: string | null): boolean {
	if (choice !== null) return choice;
	return accountZone === null || accountZone === device;
}

/** Fuso a gravar na conta para o automático acompanhar o aparelho; `null` = nada a fazer (já igual ou sem fuso do aparelho). */
export function timezoneToSync(auto: boolean, accountZone: string | null, device: string | null): string | null {
	if (!auto || !device || !isValidTimeZone(device)) return null;
	return accountZone === device ? null : device;
}
