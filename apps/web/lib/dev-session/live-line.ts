import { redactSecrets } from "@workspace/shared";
import type { AgentActivity } from "@/lib/working-status";

import { devIsWorking, devSetupLabel, devWorkStart, formatElapsed, type DevSessionView } from "./reducer";

const MAX_CHARS = 56;

function shorten(text: string, max = MAX_CHARS): string {
	// Redige antes de cortar: o comando ao vivo (args da ferramenta) ainda não passou pela redação do shell_started.
	const flat = (redactSecrets(text).split("\n")[0] ?? "").trim().split(/\s+/).join(" ");
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Caminho curto: só as duas últimas partes ("src/app.ts"). */
function shortPath(path: string): string {
	return path.split("/").filter(Boolean).slice(-2).join("/");
}

/** Argumento que identifica a chamada da ferramenta (arquivo, comando, padrão). */
export function toolActivityDetail(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const pick = (...keys: string[]) =>
		keys.map((key) => record[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
	if (name === "shell") return pick("cmd", "command");
	if (name === "read_file" || name === "write_file" || name === "edit_file") return pick("path");
	if (name === "grep") return pick("pattern", "query");
	return undefined;
}

const SETUP_PROGRESS: Record<string, string> = {
	container: "Preparando o ambiente",
	clone: "Clonando o repositório",
	checkout: "Trocando de branch",
	detect: "Detectando o ambiente",
	install: "Instalando dependências",
	start: "Iniciando o ambiente",
};

function setupProgressLabel(step: string): string {
	return SETUP_PROGRESS[step] ?? devSetupLabel(step);
}

type LiveLineInput = {
	/** Sessão de código da conversa (se houver). */
	view?: DevSessionView | undefined;
	activity: AgentActivity;
	/** Há um cartão de aprovação esperando o usuário. */
	pendingApproval?: boolean;
	now: number;
};

/**
 * Uma linha, em português simples, com o que o agente faz agora. Usa o evento mais recente
 * (comando rodando, passo do ambiente, ferramenta em uso) e cai em "Pensando…" quando só o
 * modelo está gerando. `null` = sem nada melhor que o texto padrão.
 */
export function devLiveLine({ view, activity, pendingApproval = false, now }: LiveLineInput): string | null {
	if (pendingApproval) return "Aguardando sua aprovação";
	if (view && (devIsWorking(view) || view.status === "CREATING")) {
		const running = [...view.commands].reverse().find((command) => command.status === "running");
		if (running) return `Rodando ${shorten(running.cmd)}… ${formatElapsed(Math.max(0, now - running.startedAt))}`;
		const setup = view.setup.find((step) => step.status === "running");
		if (setup) return `${setupProgressLabel(setup.step)}…`;
		if (view.status === "QUEUED") return "Na fila, aguardando recursos…";
		if (view.status === "CREATING") return "Preparando o ambiente…";
	}
	if (activity.phase === "tool") {
		const detail = activity.detail ? shorten(activity.detail) : "";
		switch (activity.tool) {
			case "read_file":
				return detail ? `Lendo ${shortPath(detail)}` : "Lendo arquivos";
			case "edit_file":
			case "write_file": {
				const start = view ? devWorkStart(view) : 0;
				const paths = new Set((view?.edits ?? []).filter((edit) => edit.at >= start).map((edit) => edit.path));
				if (detail) paths.add(detail);
				if (paths.size >= 2) return `Editando ${paths.size} arquivos`;
				return detail ? `Editando ${shortPath(detail)}` : "Editando um arquivo";
			}
			case "grep":
			case "glob":
				return "Buscando no código";
			case "shell":
				return detail ? `Rodando ${shorten(detail)}…` : "Rodando um comando…";
			case "shell_output":
			case "shell_stdin":
			case "shell_kill":
				return "Acompanhando o comando…";
			case "dev_session_start":
				return "Preparando o ambiente…";
			case "dev_pr_create":
				return "Abrindo o pull request…";
			case "dev_ci_status":
			case "dev_ci_logs":
				return "Verificando os checks…";
			default:
				return view ? "Trabalhando no código…" : null;
		}
	}
	if (!view) return null;
	return activity.phase === "writing" ? "Escrevendo a resposta…" : "Pensando…";
}
