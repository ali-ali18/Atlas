/**
 * Registro curto do login com Google, mostrado na própria tela de login para o dono mandar print quando o retorno
 * ao app falha. Guarda só o caminho percorrido (abriu o navegador, voltou link, trocou o token); o valor do token,
 * do `state` e do verificador nunca entra: um link vira "esquema://host/caminho" + os nomes dos parâmetros.
 */

export const TRACE_MAX_LINES = 25;
const LINE_MAX_LENGTH = 160;

/** Descreve um link sem os valores: `exp://u.expo.dev/x/--/ [token,state]`. */
export function describeLink(url: string | null | undefined): string {
	if (!url) return "(vazio)";
	const [base = "", query = ""] = url.split("#")[0]?.split("?") ?? [];
	const names = query
		.split("&")
		.map((pair) => pair.split("=")[0])
		.filter((name): name is string => Boolean(name))
		.map((name) => name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24));
	const shortBase = base.length > 90 ? `${base.slice(0, 90)}…` : base;
	return names.length ? `${shortBase} [${names.join(",")}]` : shortBase;
}

/** Hora local "HH:MM:SS" de um instante. */
export function clock(at: number): string {
	const d = new Date(at);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Acrescenta uma linha e mantém só as últimas `TRACE_MAX_LINES`. */
export function appendTrace(lines: readonly string[], message: string, at: number): string[] {
	const line = `${clock(at)} ${message}`.slice(0, LINE_MAX_LENGTH);
	return [...lines, line].slice(-TRACE_MAX_LINES);
}

export type TraceStorage = {
	get: () => Promise<string | null>;
	set: (value: string) => Promise<void>;
};

export function parseTrace(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string").slice(-TRACE_MAX_LINES) : [];
	} catch {
		return [];
	}
}

/**
 * Registro em memória espelhado no armazenamento: se o Expo Go recarregar o app ao receber o link, a tela nova
 * ainda mostra o que aconteceu antes. Falha ao gravar não atrapalha o login.
 */
export function createLoginTrace(storage: TraceStorage, now: () => number = Date.now) {
	let lines: string[] = [];
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	let ready: Promise<void> | null = null;

	function load(): Promise<void> {
		ready ??= storage
			.get()
			.then((raw) => {
				lines = [...parseTrace(raw), ...lines].slice(-TRACE_MAX_LINES);
				notify();
			})
			.catch(() => undefined);
		return ready;
	}

	function add(message: string): void {
		lines = appendTrace(lines, message, now());
		notify();
		void load().then(() => storage.set(JSON.stringify(lines)).catch(() => undefined));
	}

	function clear(): void {
		lines = [];
		notify();
		void storage.set("[]").catch(() => undefined);
	}

	return {
		add,
		clear,
		load,
		get: (): readonly string[] => lines,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
