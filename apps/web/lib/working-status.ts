export type AgentActivity =
	| { phase: "idle" }
	| { phase: "thinking" }
	| { phase: "writing" }
	/** O rascunho foi retirado e a resposta está sendo refeita. */
	| { phase: "revising" }
	| { phase: "tool"; tool: string; step?: number; maxSteps?: number; /** Alvo da chamada (arquivo, comando), curto. */ detail?: string };

/** Fase do indicador quando chega texto (`writing`) ou quando o rascunho é retirado (`revising`). */
// Objetos fixos: o stream chama isto a cada token e o mesmo valor não dispara outro render do estado.
const WRITING: AgentActivity = { phase: "writing" };
const REVISING: AgentActivity = { phase: "revising" };

export function activityForAssistantEvent(type: "assistant_delta" | "assistant_discard"): AgentActivity {
	return type === "assistant_discard" ? REVISING : WRITING;
}

export function statusForTool(tool: string): string {
	switch (tool) {
		case "screenshot":
			return "está olhando a tela";
		case "navigate":
		case "browser_text":
		case "browser_links":
			return "está pesquisando";
		case "type":
		case "browser_type":
		case "key":
			return "está digitando";
		case "click":
		case "browser_click":
			return "está clicando";
		case "scroll":
			return "está rolando a página";
		case "memory":
			return "está consultando a memória";
		default:
			return "está trabalhando";
	}
}

export function workingStatusLabel(
	agentName: string,
	activity: AgentActivity,
	options?: { paused?: boolean; tick?: number; status?: string | null },
): string {
	if (options?.paused || options?.status === "paused") {
		return `${agentName} está aguardando novas instruções`;
	}

	switch (options?.status) {
		case "queued":
			return `${agentName} está começando`;
		case "waiting_user":
			return `${agentName} está aguardando você`;
		case "waiting_external":
			return `${agentName} está aguardando um serviço externo`;
		case "retrying":
			return `${agentName} está tentando de novo`;
		default:
			break;
	}

	switch (activity.phase) {
		case "writing":
			return `${agentName} está escrevendo`;
		case "tool": {
			const base = `${agentName} ${statusForTool(activity.tool)}`;
			if (
				typeof activity.step === "number" &&
				typeof activity.maxSteps === "number"
			) {
				return `${base} (passo ${activity.step + 1} de ${activity.maxSteps})`;
			}
			return base;
		}
		case "revising":
			return "Revisando a resposta…";
		case "thinking":
			return `${agentName} está trabalhando`;
		default:
			return `${agentName} está trabalhando`;
	}
}
