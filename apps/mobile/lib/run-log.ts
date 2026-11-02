import { splitMcpTool, toolKind } from "@workspace/shared";

// Registro de uma execução: a linha do tempo dos passos, só com o que ajuda a entender ("Pesquisou na web", hora,
// deu certo ou deu erro). NUNCA o comando, os argumentos, a saída nem o caminho: o evento do run pode carregar segredo e,
// pela regra do produto, o app não mostra nome de ferramenta nem campo. Lógica pura.

/** Evento do run como o servidor devolve em `GET /v1/runs/:id/events` (só o que o Registro lê). */
export type RunEventLike = { seq: number; type: string; payload: unknown; createdAt: string };

/** Grupo do ícone do passo (a família da ferramenta, sem expor o nome dela). */
export type StepIcon = "web" | "read" | "run" | "code" | "other";

export type RunLogStep = { id: string; label: string; icon: StepIcon; /** `null`: ainda sem resultado. */ ok: boolean | null; at: string };

export function stepIcon(tool: string): StepIcon {
	const kind = toolKind(tool);
	if (kind === "web") return "web";
	if (kind === "read" || kind === "navigate" || kind === "screenshot") return "read";
	if (kind === "run") return "run";
	if (kind === "code") return "code";
	return "other";
}

/** Frase curta do passo pela família da ferramenta; `null` = não vira passo (raciocínio sem efeito fora). */
/** Atualizar a lista de tarefas é bastidor do plano (já aparece nas Execuções), não um passo. */
const BACKSTAGE = new Set(["update_task_list"]);

export function stepLabel(tool: string): string | null {
	if (BACKSTAGE.has(tool)) return null;
	const kind = toolKind(tool);
	switch (kind) {
		case "web":
			return "Pesquisou na web";
		case "read":
			return "Leu uma página ou arquivo";
		case "navigate":
			return "Abriu uma página";
		case "screenshot":
			return "Tirou uma captura da tela";
		case "type":
		case "click":
		case "act":
		case "scroll":
			return "Usou o navegador";
		case "memory":
			return "Consultou a memória";
		case "code":
			return "Escreveu código";
		case "run":
			return "Rodou um comando";
		case "delegate":
			return "Pediu ajuda a outro bot";
		case "think":
			return null;
		default:
			return splitMcpTool(tool) ? "Usou um conector" : "Fez uma ação";
	}
}

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** Passos na ordem das chamadas; cada `tool_call` casa com o `tool_result` de mesmo id (sem resultado = em andamento). */
export function buildRunLog(events: readonly RunEventLike[]): RunLogStep[] {
	const steps: RunLogStep[] = [];
	const byCall = new Map<string, RunLogStep>();
	for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
		const payload = asRecord(event.payload);
		if (!payload) continue;
		const id = typeof payload.id === "string" ? payload.id : null;
		if (event.type === "tool_call" && id && typeof payload.name === "string") {
			const label = stepLabel(payload.name);
			if (!label || byCall.has(id)) continue;
			const step: RunLogStep = { id, label, icon: stepIcon(payload.name), ok: null, at: event.createdAt };
			byCall.set(id, step);
			steps.push(step);
		} else if (event.type === "tool_result" && id) {
			const step = byCall.get(id);
			if (step) step.ok = payload.ok === true;
		}
	}
	return steps;
}

/**
 * Título da tela de uma execução, como o "Programando" do Grok: o que o bot mais fez nela, em uma palavra (sem a palavra
 * "execução", que fica estranha de título). Empate vai para a ordem code, run, web, read.
 */
export function activityTitle(steps: readonly Pick<RunLogStep, "icon">[]): string {
	const count: Record<StepIcon, number> = { web: 0, read: 0, run: 0, code: 0, other: 0 };
	for (const step of steps) count[step.icon] += 1;
	const order: StepIcon[] = ["code", "run", "web", "read"];
	let best: StepIcon | null = null;
	for (const icon of order) if (count[icon] > 0 && (best === null || count[icon] > count[best])) best = icon;
	switch (best) {
		case "code":
			return "Programando";
		case "run":
			return "Executando comandos";
		case "web":
			return "Pesquisando";
		case "read":
			return "Lendo";
		default:
			return "Trabalhando";
	}
}
