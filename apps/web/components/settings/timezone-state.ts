import { isValidTimeZone } from "@workspace/shared";
import { normalizeSearch } from "./settings-registry";

/** Fusos mais usados por quem escreve em português: aparecem se o navegador não lista os fusos. */
const FALLBACK_ZONES = [
	"America/Sao_Paulo",
	"America/Manaus",
	"America/Fortaleza",
	"America/Bahia",
	"America/Cuiaba",
	"America/Rio_Branco",
	"America/Noronha",
	"America/Argentina/Buenos_Aires",
	"America/New_York",
	"America/Los_Angeles",
	"Europe/Lisbon",
	"Europe/London",
	"Europe/Madrid",
	"Asia/Tokyo",
	"UTC",
];

/** Todos os fusos que o navegador conhece (IANA), em ordem alfabética, com `UTC` sempre presente. */
export function listTimeZones(): string[] {
	let zones: string[] = [];
	try {
		const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
		zones = supported ? supported("timeZone") : [];
	} catch {
		zones = [];
	}
	const all = new Set(zones.length > 0 ? zones : FALLBACK_ZONES);
	all.add("UTC");
	return [...all].sort((a, b) => a.localeCompare(b));
}

/** Fuso do navegador (o padrão quando a conta não escolheu); `undefined` se indisponível. */
export function detectedTimeZone(): string | undefined {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimeZone(zone) ? zone : undefined;
	} catch {
		return undefined;
	}
}

/** "GMT-3" no fuso, ou "" se não der para calcular. */
export function timeZoneOffset(zone: string, now: Date = new Date()): string {
	try {
		const part = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, timeZoneName: "shortOffset" })
			.formatToParts(now)
			.find((item) => item.type === "timeZoneName");
		return part?.value ?? "";
	} catch {
		return "";
	}
}

/** Nomes IANA vêm sem acento; estes ganham o acento em português. */
const ACCENTED: Readonly<Record<string, string>> = {
	"Sao Paulo": "São Paulo",
	Belem: "Belém",
	Cuiaba: "Cuiabá",
	Maceio: "Maceió",
	Santarem: "Santarém",
	"Sao Tome": "São Tomé",
	Asuncion: "Asunción",
	Bogota: "Bogotá",
	Cancun: "Cancún",
	Merida: "Mérida",
};

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export function timeZoneCity(zone: string): string {
	const last = (zone.split("/").pop() ?? zone).replace(/_/g, " ");
	return ACCENTED[last] ?? last;
}

/** "São Paulo (GMT-3)": cidade + deslocamento atual. */
export function timeZoneLabel(zone: string, now: Date = new Date()): string {
	const offset = timeZoneOffset(zone, now);
	return offset ? `${timeZoneCity(zone)} (${offset})` : timeZoneCity(zone);
}

/** Busca por cidade, região ou id, sem acento nem caixa. */
export function filterTimeZones(zones: readonly string[], rawQuery: string): string[] {
	const query = normalizeSearch(rawQuery).replace(/\s+/g, " ");
	if (!query) return [...zones];
	return zones.filter((zone) => {
		const haystack = normalizeSearch(`${zone.replace(/[/_]/g, " ")} ${timeZoneOffset(zone)}`);
		return haystack.includes(query);
	});
}

/** Fuso mostrado na linha: o da conta, ou o do navegador quando a conta não escolheu. */
export function shownTimeZone(
	account: string | undefined,
	detected: string | undefined,
): { zone: string; auto: boolean } {
	if (account && isValidTimeZone(account)) return { zone: account, auto: false };
	return { zone: detected ?? "America/Sao_Paulo", auto: true };
}
