// DIAGNÓSTICO TEMPORÁRIO da tela Aplicativos (travamento + app fechando sozinho no Android). Sem acesso ao Metro, o app
// grava um registro de etapas no aparelho a cada passo; na abertura seguinte o dono lê o da vez anterior (segurar o
// título "Aplicativos"). Remover junto com a correção.
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Teto de linhas: passou disso, as mais antigas somem (o fim do registro é o que importa num travamento). */
export const MAX_LINES = 60;
export const STORAGE_KEY = "atlas.apps-diagnostics.v1";

export type DiagValue = number | string;
/** Mesma `key` = substitui a linha em vez de acrescentar (ex.: contador de renders). */
export type DiagEntry = { text: string; key?: string };

/** `+1234ms etapa a=1 b=x`: horário relativo, etapa e números. Sem texto grande (corta valor longo). */
export function formatLine(ms: number, stage: string, nums: Readonly<Record<string, DiagValue>> = {}): string {
	const parts = Object.entries(nums).map(([name, value]) => `${name}=${typeof value === "string" && value.length > 40 ? `${value.slice(0, 40)}…` : value}`);
	return [`+${Math.max(0, Math.round(ms))}ms`, stage, ...parts].join(" ");
}

/** Acrescenta (ou substitui, se a chave já existe) e mantém só as últimas `max` linhas. Não muda o array recebido. */
export function addEntry(entries: readonly DiagEntry[], entry: DiagEntry, max = MAX_LINES): DiagEntry[] {
	const replaces = entry.key !== undefined && entries.some((item) => item.key === entry.key);
	const next = replaces ? entries.map((item) => (item.key === entry.key ? entry : item)) : [...entries, entry];
	return next.length > max ? next.slice(next.length - max) : next;
}

export function entriesToText(entries: readonly DiagEntry[]): string {
	return entries.map((entry) => entry.text).join("\n");
}

// ---- estado do módulo (uma abertura da tela por vez) ------------------------------------------------------------------

let started = false;
let t0 = 0;
let entries: DiagEntry[] = [];
// Só grava depois de ler o registro anterior: senão o primeiro passo apagaria o que o dono quer ver.
let persistReady = false;
let previous: Promise<string> = Promise.resolve("");

function persist(): void {
	if (!persistReady) return;
	// Uma escrita por etapa, sem esperar: o AsyncStorage as enfileira em ordem no lado nativo e elas sobrevivem ao app ser morto.
	void AsyncStorage.setItem(STORAGE_KEY, entriesToText(entries)).catch(() => undefined);
}

/** Abre a tela: guarda o registro da vez anterior (leitura ANTES de qualquer escrita) e zera o relógio. */
export function beginAppsDiagnostics(): Promise<string> {
	started = true;
	t0 = Date.now();
	entries = [];
	persistReady = false;
	previous = AsyncStorage.getItem(STORAGE_KEY).then(
		(stored) => stored ?? "",
		() => "",
	);
	void previous.then(() => {
		persistReady = true;
		persist();
	});
	log("tela aberta");
	return previous;
}

/** O registro da vez anterior (vazio se não houve). */
export function readPreviousAppsLog(): Promise<string> {
	return previous;
}

export function log(stage: string, nums?: Readonly<Record<string, DiagValue>>): void {
	if (!started) return;
	entries = addEntry(entries, {
		text: formatLine(Date.now() - t0, stage, nums),
	});
	persist();
}

/** Renders: uma linha só, atualizada no lugar (uma cascata de renders não empurra as outras etapas para fora do teto). */
export function logRender(nums: Readonly<Record<string, DiagValue>>): void {
	if (!started) return;
	entries = addEntry(entries, {
		key: "render",
		text: formatLine(Date.now() - t0, "render", nums),
	});
	persist();
}

/** Mede um trecho: registra `etapa:fim` com a duração (e o que `describe` tirar do resultado) ou `etapa:falhou`. */
export async function timedStage<T>(stage: string, run: () => Promise<T>, describe?: (value: T) => Record<string, DiagValue>): Promise<T> {
	const from = Date.now();
	log(`${stage}:início`);
	try {
		const value = await run();
		log(`${stage}:fim`, {
			dur: Date.now() - from,
			...(describe ? describe(value) : {}),
		});
		return value;
	} catch (error) {
		log(`${stage}:falhou`, {
			dur: Date.now() - from,
			erro: error instanceof Error ? error.message : "?",
		});
		throw error;
	}
}
