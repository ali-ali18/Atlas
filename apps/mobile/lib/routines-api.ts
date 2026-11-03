// Rotinas do bot: os mesmos endpoints do web (`apps/web/lib/atlas-api.ts`). O servidor filtra tudo pelo dono da
// sessão (recurso de outro dono dá 404); o app só manda o id do bot e o da rotina, nunca um userId.
import type { RoutineGroupRecord, RoutineRecord, RoutineRunRecord } from "@workspace/shared";
import { ChatApiError } from "./chat-api";
import type { ApiFetch } from "./home-sync";

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" };
const base = (botId: string) => `/v1/bots/${encodeURIComponent(botId)}`;

async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
	return (await response.json()) as T;
}

/** `GET /v1/bots/:botId/routines` e `/routine-groups`, em paralelo. */
export async function listRoutines(apiFetch: ApiFetch, botId: string): Promise<{ routines: RoutineRecord[]; groups: RoutineGroupRecord[] }> {
	const [routines, groups] = await Promise.all([
		apiFetch(`${base(botId)}/routines`, { headers: { accept: "application/json" } }).then((response) => readJson<{ routines?: RoutineRecord[] }>(response)),
		apiFetch(`${base(botId)}/routine-groups`, { headers: { accept: "application/json" } }).then((response) => readJson<{ groups?: RoutineGroupRecord[] }>(response)),
	]);
	return { routines: Array.isArray(routines.routines) ? routines.routines : [], groups: Array.isArray(groups.groups) ? groups.groups : [] };
}

/** Pausar/retomar: `PATCH /v1/bots/:botId/routines/:routineId` com `{ enabled }`. */
export async function setRoutineEnabled(apiFetch: ApiFetch, botId: string, routineId: string, enabled: boolean): Promise<void> {
	const response = await apiFetch(`${base(botId)}/routines/${encodeURIComponent(routineId)}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ enabled }) });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
}

/** Rotina nova de um bot (`POST /v1/bots/:botId/routines`): o corpo que o web manda ao instalar do catálogo (`createRoutine`), ligada. */
export async function createRoutine(apiFetch: ApiFetch, botId: string, input: { name: string; prompt: string; schedule: string }): Promise<void> {
	const response = await apiFetch(`${base(botId)}/routines`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: input.name, prompt: input.prompt, schedule: input.schedule, enabled: true }) });
	if (!response.ok) throw new ChatApiError(response.statusText || `HTTP ${response.status}`, response.status);
}

/** `GET /v1/bots/:botId/routines/:routineId/runs`: as execuções recentes (até 20). */
export async function listRoutineRuns(apiFetch: ApiFetch, botId: string, routineId: string): Promise<RoutineRunRecord[]> {
	const body = await readJson<{ runs?: RoutineRunRecord[] }>(await apiFetch(`${base(botId)}/routines/${encodeURIComponent(routineId)}/runs`, { headers: { accept: "application/json" } }));
	return Array.isArray(body.runs) ? body.runs : [];
}

/** Frase simples para o erro (sem texto técnico). `action`: o que se tentava fazer. */
export function routinesErrorText(error: unknown, action: "load" | "pause" | "resume" | "history"): string {
	if (error instanceof ChatApiError) {
		if (error.status === 401) return "Sua sessão expirou. Entre de novo.";
		if (error.status === 404) return "Não encontrei esta rotina. Ela pode ter sido apagada.";
	}
	// Falha de rede no RN chega como TypeError: é "sem conexão", não erro do servidor.
	if (error instanceof ChatApiError) {
		return action === "load" ? "Não consegui carregar as rotinas agora." : action === "history" ? "Não foi possível carregar o histórico." : action === "pause" ? "Não foi possível pausar esta rotina." : "Não foi possível retomar esta rotina.";
	}
	return "Sem conexão com o seu servidor. Tente de novo.";
}
