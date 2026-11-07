// Proveniência de dado não confiável (cláusula 8), a defesa contra a "trifeta letal".
//
// Duas perguntas, ambas sobre FLUXO DE DADOS e nunca sobre o que o usuário escreveu:
//  1. `untrustedReadInRun`: alguma tool declarada `trust: "untrusted"` (e-mail, web, arquivo, MCP de
//     terceiro, outro bot) devolveu resultado neste run? Sinal estrutural, vem da declaração da tool.
//  2. `argsCarryUntrusted`: algum argumento desta chamada contém um trecho de >= 24 caracteres
//     copiado de um resultado não confiável do run? É uma heurística determinística de proveniência
//     (janela deslizante exata, sem regex nem interpretação de linguagem): pode errar para menos
//     (modelo parafraseou), mas então vale o sinal 1, que já cobre o run inteiro. Não decide
//     comportamento a partir de texto do usuário.
// O resultado vai para `decide()` como dois booleanos; o texto nunca chega ao autorizador.

/** Origem declarada pela tool. */
export const TRUST_SOURCES = ["email", "web", "file", "mcp", "other_bot"] as const;
export type TrustSource = (typeof TRUST_SOURCES)[number];

/**
 * Quem guarda dado privado do dono, por origem declarada (N2 da reauditoria F1). Exaustivo por tipo: origem nova
 * em `TRUST_SOURCES` sem entrada aqui não compila. `declared` = depende de quem fornece (cada conector MCP declara).
 */
export const TRUST_SOURCE_PRIVACY = {
	email: "private",
	file: "private",
	web: "public",
	other_bot: "public",
	mcp: "declared",
} as const satisfies Record<TrustSource, "private" | "public" | "declared">;

/** Origens que SEMPRE trazem dado do dono: uma tool `read` com uma delas tem de declarar `privateData: true`. */
export const PRIVATE_TRUST_SOURCES: readonly TrustSource[] = TRUST_SOURCES.filter((source) => TRUST_SOURCE_PRIVACY[source] === "private");

/**
 * Tipo de dado do dono que uma tool devolve, declarado na própria tool. Cobre o que `TrustSource` não cobre
 * (memória é do dono e confiável, então não tem `source`). Declarar um tipo exige `privateData: true`.
 */
export const OWNER_DATA_KINDS = ["email", "file", "memory", "connector", "purchase"] as const;
export type OwnerDataKind = (typeof OWNER_DATA_KINDS)[number];

/** Tamanho mínimo (caracteres) de um trecho copiado para contar como dado carregado nos argumentos. */
export const MIN_COPIED_SPAN = 24;
/** Tetos de memória: passado deles, só `untrustedReadInRun` (que já bloqueia o efeito externo) segue valendo. */
const MAX_GRAMS = 200_000;
const MAX_STORED_CHARS = 200_000;

export type ProvenanceSnapshot = { untrustedReadInRun: boolean; privateReadInRun?: boolean; sources: TrustSource[]; texts: string[] };

export class RunProvenance {
	untrustedReadInRun = false;
	/** Alguma tool com `privateData` devolveu dado do dono neste run (lado privado da trifeta). */
	privateReadInRun = false;
	private readonly sources = new Set<TrustSource>();
	private readonly texts: string[] = [];
	private storedChars = 0;
	private readonly grams = new Set<string>();

	static restore(snapshot: ProvenanceSnapshot): RunProvenance {
		const p = new RunProvenance();
		for (const text of snapshot.texts) p.index(text);
		p.untrustedReadInRun = snapshot.untrustedReadInRun;
		p.privateReadInRun = snapshot.privateReadInRun === true;
		for (const s of snapshot.sources) p.sources.add(s);
		return p;
	}

	/** Chame com TODO texto que voltou de uma tool não confiável (resultado ou erro). */
	record(text: string, source: TrustSource): void {
		this.untrustedReadInRun = true;
		this.sources.add(source);
		this.index(text);
	}

	private index(text: string): void {
		if (this.storedChars + text.length <= MAX_STORED_CHARS) {
			this.texts.push(text);
			this.storedChars += text.length;
		}
		for (let i = 0; i + MIN_COPIED_SPAN <= text.length && this.grams.size < MAX_GRAMS; i++) {
			this.grams.add(text.slice(i, i + MIN_COPIED_SPAN));
		}
	}

	/** Uma tool com `privateData` devolveu dado do dono. */
	markPrivateRead(): void {
		this.privateReadInRun = true;
	}

	/** Algum texto dos argumentos tem um trecho (>= MIN_COPIED_SPAN) idêntico a algo lido de fonte não confiável? */
	carries(args: unknown): boolean {
		if (this.grams.size === 0) return false;
		return anyString(args, (s) => {
			for (let i = 0; i + MIN_COPIED_SPAN <= s.length; i++) if (this.grams.has(s.slice(i, i + MIN_COPIED_SPAN))) return true;
			return false;
		});
	}

	snapshot(): ProvenanceSnapshot {
		return { untrustedReadInRun: this.untrustedReadInRun, privateReadInRun: this.privateReadInRun, sources: [...this.sources], texts: [...this.texts] };
	}
}

function anyString(value: unknown, test: (s: string) => boolean): boolean {
	if (typeof value === "string") return test(value);
	if (Array.isArray(value)) return value.some((v) => anyString(v, test));
	if (typeof value === "object" && value !== null) return Object.values(value).some((v) => anyString(v, test));
	return false;
}
