import { redactSecrets } from "@workspace/shared";
import type { AgentActivity } from "@/lib/working-status";

import { devIsWorking, devSetupLabel, devWorkStart, formatElapsed, type DevSessionView } from "./reducer";
import { activeLabel, activeT, getActiveTranslator } from "@/lib/i18n/active";
import type { MessageKey } from "@/lib/i18n/translator";

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

const SETUP_PROGRESS_KEY = {
	container: "status.dev.setup.container",
	clone: "status.dev.setup.clone",
	checkout: "status.dev.setup.checkout",
	detect: "status.dev.setup.detect",
	install: "status.dev.setup.install",
	start: "status.dev.setup.start",
} as const;

function setupProgressLabel(step: string): string {
	const key = (SETUP_PROGRESS_KEY as Record<string, MessageKey>)[step];
	return key ? activeLabel(key) : devSetupLabel(step);
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
	if (pendingApproval) return activeT("status.dev.live.awaitingApproval");
	if (view && (devIsWorking(view) || view.status === "CREATING")) {
		const running = [...view.commands].reverse().find((command) => command.status === "running");
		if (running) return activeT("status.dev.live.running", { cmd: shorten(running.cmd), elapsed: formatElapsed(Math.max(0, now - running.startedAt)) });
		const setup = view.setup.find((step) => step.status === "running");
		if (setup) return activeT("status.dev.live.step", { step: setupProgressLabel(setup.step) });
		if (view.status === "QUEUED") return activeT("status.dev.live.queued");
		if (view.status === "CREATING") return activeT("status.dev.live.preparing");
	}
	if (activity.phase === "tool") {
		const detail = activity.detail ? shorten(activity.detail) : "";
		switch (activity.tool) {
			case "read_file":
				return detail ? activeT("status.dev.live.readingPath", { path: shortPath(detail) }) : activeT("status.dev.live.readingFiles");
			case "edit_file":
			case "write_file": {
				const start = view ? devWorkStart(view) : 0;
				const paths = new Set((view?.edits ?? []).filter((edit) => edit.at >= start).map((edit) => edit.path));
				if (detail) paths.add(detail);
				if (paths.size >= 2) return activeT("status.dev.live.editingMany", { count: paths.size });
				return detail ? activeT("status.dev.live.editingPath", { path: shortPath(detail) }) : activeT("status.dev.live.editingOne");
			}
			case "grep":
			case "glob":
				return activeT("status.dev.live.searching");
			case "shell":
				return detail ? activeT("status.dev.live.runningCmd", { cmd: shorten(detail) }) : activeT("status.dev.live.runningACommand");
			case "shell_output":
			case "shell_stdin":
			case "shell_kill":
				return activeT("status.dev.live.followingCommand");
			case "dev_session_start":
				return activeT("status.dev.live.preparing");
			case "dev_pr_create":
				return activeT("status.dev.live.openingPr");
			case "dev_ci_status":
			case "dev_ci_logs":
				return activeT("status.dev.live.checkingCi");
			default:
				return view ? activeT("status.dev.live.working") : null;
		}
	}
	if (!view) return null;
	if (activity.phase === "revising") return activeT("status.dev.live.revising");
	return activity.phase === "writing" ? activeT("status.dev.live.writing") : activeT("status.dev.live.thinking");
}
