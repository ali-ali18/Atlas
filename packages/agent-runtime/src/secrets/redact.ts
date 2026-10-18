/**
 * Redação de segredos: troca o valor real (literal, URL-encoded, base64 e
 * base64url) de volta pelo marcador. Usada em resultados de ferramentas,
 * eventos, mensagens persistidas, logs e no mascaramento de mensagens recebidas.
 */

export type SecretEntry = { value: string; marker: string };

const MIN_LENGTH = 6;

function variants(value: string): string[] {
	const out = new Set<string>();
	out.add(value);
	const encoded = encodeURIComponent(value);
	if (encoded !== value) out.add(encoded);
	const buf = Buffer.from(value, "utf8");
	out.add(buf.toString("base64"));
	out.add(buf.toString("base64").replace(/=+$/, ""));
	out.add(buf.toString("base64url"));
	return [...out].filter((item) => item.length >= MIN_LENGTH);
}

export type Redactor = {
	readonly size: number;
	text: (input: string) => string;
	deep: <T>(input: T) => T;
	add: (entries: readonly SecretEntry[]) => void;
};

export function createRedactor(initial: readonly SecretEntry[] = []): Redactor {
	let table: Array<{ needle: string; marker: string }> = [];
	const seen = new Set<string>();
	const add = (entries: readonly SecretEntry[]) => {
		for (const entry of entries) {
			if (!entry.value || entry.value.length < MIN_LENGTH) continue;
			for (const needle of variants(entry.value)) {
				const key = `${needle}\u0000${entry.marker}`;
				if (seen.has(key)) continue;
				seen.add(key);
				table.push({ needle, marker: entry.marker });
			}
		}
		table = table.sort((a, b) => b.needle.length - a.needle.length);
	};
	add(initial);
	const text = (input: string): string => {
		if (!input || table.length === 0) return input;
		let out = input;
		for (const { needle, marker } of table) {
			if (out.includes(needle)) out = out.split(needle).join(marker);
		}
		return out;
	};
	const deep = <T,>(input: T): T => {
		if (table.length === 0) return input;
		if (typeof input === "string") return text(input) as T;
		if (Array.isArray(input)) return input.map((item) => deep(item)) as T;
		if (input && typeof input === "object") {
			if (input instanceof Error) return input;
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(input)) out[key] = deep(value);
			return out as T;
		}
		return input;
	};
	return {
		get size() {
			return table.length;
		},
		text,
		deep,
		add,
	};
}
