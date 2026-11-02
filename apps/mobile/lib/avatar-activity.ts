// Estados do avatar no app: os `AvatarState` do shared reduzidos a poucos, cada um com expressão e animação simples
// (o app não tem o "cérebro" do web), e o texto pt-BR do que o bot está fazendo. Puro: sem React.
import { toolKind, type AgentActivity } from "@workspace/shared";
import type { AvatarState } from "@workspace/shared/avatar/model/behavior";

export type MobileAvatarState = "idle" | "thinking" | "searching" | "reading" | "working" | "writing" | "waiting" | "happy" | "failed";

export function mobileAvatarState(state: AvatarState): MobileAvatarState {
	switch (state) {
		case "thinking":
			return "thinking";
		case "searching":
			return "searching";
		case "reading":
			return "reading";
		case "coding":
		case "running":
		case "computing":
		case "controlling":
		case "working":
		case "progress":
			return "working";
		case "streaming":
			return "writing";
		case "waiting":
			return "waiting";
		case "finished":
			return "happy";
		case "failed":
			return "failed";
		default:
			return "idle";
	}
}

/** Ferramentas que leem arquivo (anexo, sandbox, busca no disco), para dizer "Lendo o arquivo" em vez de "a página". */
const FILE_TOOLS = /^(attachment_|sandbox_download|sandbox_read|sandbox_list|checkpoint_read|artifact_read|skill_read|read|grep|find$)/;

/** Frase da ferramenta, sem o passo. */
export function toolLabel(tool: string): string {
	switch (toolKind(tool)) {
		case "web":
			return "Pesquisando na web";
		case "navigate":
		case "screenshot":
			return "Lendo a página";
		case "read":
			return FILE_TOOLS.test(tool) ? "Lendo o arquivo" : "Lendo a página";
		case "memory":
			return "Consultando a memória";
		case "code":
			return "Escrevendo código";
		case "run":
			return "Rodando um comando";
		case "type":
		case "click":
		case "scroll":
		case "act":
			return "Usando o computador";
		case "delegate":
			return "Pedindo ajuda a outro bot";
		case "think":
		case "other":
			return "Trabalhando…";
	}
}

/** O que o bot está fazendo agora, com "(passo X de Y)" quando o servidor informa o passo. */
export function activityLabel(activity: AgentActivity): string {
	switch (activity.phase) {
		case "thinking":
		case "revising":
			return "Pensando…";
		case "writing":
			return "Escrevendo…";
		case "tool": {
			const base = toolLabel(activity.tool);
			if (typeof activity.step === "number" && typeof activity.maxSteps === "number" && activity.maxSteps > 0) {
				return `${base} (passo ${activity.step + 1} de ${activity.maxSteps})`;
			}
			return base;
		}
		case "idle":
			return "Trabalhando…";
	}
}

/** Texto de um estado quando nenhuma atividade o explica (esperando, erro, fim, ou a família já terminou). */
export function stateLabel(state: MobileAvatarState): string | null {
	switch (state) {
		case "idle":
			return null;
		case "thinking":
			return "Pensando…";
		case "searching":
			return "Pesquisando na web";
		case "reading":
			return "Lendo a página";
		case "working":
			return "Trabalhando…";
		case "writing":
			return "Escrevendo…";
		case "waiting":
			return "Esperando você";
		case "happy":
			return "Pronto";
		case "failed":
			return "Algo deu errado";
	}
}
