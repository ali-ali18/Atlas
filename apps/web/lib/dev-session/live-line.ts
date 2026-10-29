import { redactSecrets } from "@workspace/shared";
import type { AgentActivity } from "@/lib/working-status";

import { devIsWorking, devSetupLabel, devWorkStart, formatElapsed, type DevSessionView } from "./reducer";
import { getActiveTranslator } from "@/lib/i18n/active";
import type { MessageKey, Translator } from "@/lib/i18n/translator";

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

function setupProgressLabel(step: string, translator: Translator): string {
	const key = (SETUP_PROGRESS_KEY as Record<string, MessageKey>)[step];
	return key ? (translator.t as (key: MessageKey) => string)(key) : devSetupLabel(step, undefined, undefined, translator);
}

type LiveLineInput = {
	/** Sessão de código da conversa (se houver). */
	view?: DevSessionView | undefined;
	activity: AgentActivity;
	/** Há um cartão de aprovação esperando o usuário. */
	pendingApproval?: boolean;
	now: number;
	/** Idioma da linha; sem ele vale o da tela registrado (só confiável fora da renderização). */
	translator?: Translator;
};

/**
 * Uma linha, em português simples, com o que o agente faz agora. Usa o evento mais recente
 * (comando rodando, passo do ambiente, ferramenta em uso) e cai em "Pensando…" quando só o
 * modelo está gerando. `null` = sem nada melhor que o texto padrão.
 */
export function devLiveLine({ view, activity, pendingApproval = false, now, translator = getActiveTranslator() }: LiveLineInput): string | null {
	const { t } = translator;
	if (pendingApproval) return t("status.dev.live.awaitingApproval");
	if (view && (devIsWorking(view) || view.status === "CREATING")) {
		const running = [...view.commands].reverse().find((command) => command.status === "running");
		if (running) return t("status.dev.live.running", { cmd: shorten(running.cmd), elapsed: formatElapsed(Math.max(0, now - running.startedAt)) });
		const setup = view.setup.find((step) => step.status === "running");
		if (setup) return t("status.dev.live.step", { step: setupProgressLabel(setup.step, translator) });
		if (view.status === "QUEUED") return t("status.dev.live.queued");
		if (view.status === "CREATING") return t("status.dev.live.preparing");
	}
	if (activity.phase === "tool") {
		const detail = activity.detail ? shorten(activity.detail) : "";
		switch (activity.tool) {
			case "read_file":
				return detail ? t("status.dev.live.readingPath", { path: shortPath(detail) }) : t("status.dev.live.readingFiles");
			case "edit_file":
			case "write_file": {
				const start = view ? devWorkStart(view) : 0;
				const paths = new Set((view?.edits ?? []).filter((edit) => edit.at >= start).map((edit) => edit.path));
				if (detail) paths.add(detail);
				if (paths.size >= 2) return t("status.dev.live.editingMany", { count: paths.size });
				return detail ? t("status.dev.live.editingPath", { path: shortPath(detail) }) : t("status.dev.live.editingOne");
			}
			case "grep":
			case "glob":
				return t("status.dev.live.searching");
			case "shell":
				return detail ? t("status.dev.live.runningCmd", { cmd: shorten(detail) }) : t("status.dev.live.runningACommand");
			case "shell_output":
			case "shell_stdin":
			case "shell_kill":
				return t("status.dev.live.followingCommand");
			case "dev_session_start":
				return t("status.dev.live.preparing");
			case "dev_pr_create":
				return t("status.dev.live.openingPr");
			case "dev_ci_status":
			case "dev_ci_logs":
				return t("status.dev.live.checkingCi");
			default:
				return view ? t("status.dev.live.working") : null;
		}
	}
	if (!view) return null;
	if (activity.phase === "revising") return t("status.dev.live.revising");
	return activity.phase === "writing" ? t("status.dev.live.writing") : t("status.dev.live.thinking");
}
