import {
	computerStateKey,
	createStallTracker,
	emptyComputerMetrics,
	hashString,
	recordComputerCall,
	type ComputerMetrics,
} from "@workspace/shared";
import { classifyBlockPage } from "../jev/block-page.js";
import { checkCaptchaWall, type LoginEvent } from "./computer-refs.js";
import { VERIFY_WARNING_PREFIX } from "./computer.js";
import { NATIVE_COMPUTER_TOOL_NAME, translateNativeComputerAction } from "./computer-native.js";

/**
 * F12/D1-D4 — observador do computador em um run: métricas (usage.computer),
 * estagnação por estado da página, bloqueio e captcha. Fica fora do
 * `computer-use.ts`: o loop só chama `afterCall` depois de cada tool.
 */

/** Ações que mudam (ou deveriam mudar) a página sem observá-la. */
const ACTION_TOOLS = new Set(["click", "type", "key", "scroll", "browser_click", "browser_type", "navigate", "browser_act"]);
/** Tools que devolvem a página e por isso ancoram o estado. */
const PAGE_READ_TOOLS = new Set(["navigate", "browser_text", "browser_snapshot", "browser_read"]);

export type GuardCall = {
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
	ms: number;
	summary: string;
	/** Screenshot enviada ao modelo (data URL), quando houver. */
	image?: string;
};

export type GuardResult = {
	/** Texto para anexar ao resumo da tool (começa com quebra de linha). */
	note: string;
	/** Motivo (pt-BR) para abortar o run por falta de progresso. */
	abort?: string;
	/** Captcha: card + pausa, no mesmo caminho do login. */
	loginEvent?: LoginEvent;
};

/** Nome efetivo: a tool `computer` vale pela primeira ação traduzida. */
function effectiveTool(name: string, args: Record<string, unknown>): string {
	if (name !== NATIVE_COMPUTER_TOOL_NAME) return name;
	try {
		return translateNativeComputerAction(args)[0]?.name ?? name;
	} catch {
		return name;
	}
}

/** URL e título que as tools de página escrevem no começo do resumo. */
export function pageFromSummary(summary: string): { url: string; title: string } | null {
	const open = /^Abriu (\S+) \(título: ([^)\n]*)\)/.exec(summary);
	if (open) return { url: open[1] ?? "", title: open[2] ?? "" };
	const head = /^([^\n]*?) \((https?:\/\/[^\s)]+)\)/.exec(summary);
	if (head) return { url: head[2] ?? "", title: head[1] ?? "" };
	return null;
}

export function createComputerGuard(options: {
	runId?: string;
	/** Chaves já perguntadas ao usuário (compartilhada com o login; vai ao checkpoint). */
	asked: Set<string>;
	initialMetrics?: ComputerMetrics;
}) {
	let metrics = { ...emptyComputerMetrics(), ...options.initialMetrics };
	const tracker = createStallTracker();
	let lastStalled = 0;

	function stateOf(tool: string, call: GuardCall): string | null {
		if (tool === "screenshot") {
			return call.image ? hashString(call.image) : null;
		}
		if (tool === "browser_snapshot" || tool === "browser_text" || tool === "browser_read") {
			return computerStateKey({ lines: call.summary.split("\n") });
		}
		return null;
	}

	return {
		metrics: (): ComputerMetrics => metrics,
		afterCall(call: GuardCall): GuardResult {
			const tool = effectiveTool(call.name, call.args);
			metrics = recordComputerCall(metrics, { tool, ok: call.ok, ms: call.ms });
			if (!call.ok) return { note: "" };
			if (call.summary.includes(VERIFY_WARNING_PREFIX)) metrics = { ...metrics, verifyWarnings: metrics.verifyWarnings + 1 };

			const notes: string[] = [];
			let abort: string | undefined;
			let loginEvent: LoginEvent | undefined;

			// D3 — captcha pede ajuda humana; bloqueio sem desafio manda trocar de fonte.
			if (PAGE_READ_TOOLS.has(tool)) {
				const page = pageFromSummary(call.summary);
				if (page) {
					const captcha = checkCaptchaWall(
						{ runId: options.runId, loginAsked: options.asked },
						{ url: page.url, title: page.title, text: call.summary },
					);
					if (captcha) {
						metrics = { ...metrics, blocks: metrics.blocks + 1 };
						notes.push(captcha.note);
						loginEvent = captcha.loginEvent;
					} else if (
						!call.summary.includes("looks like a block") &&
						call.summary.length < 4_000 &&
						classifyBlockPage(call.summary) === "blocked"
					) {
						metrics = { ...metrics, blocks: metrics.blocks + 1 };
						notes.push(
							"\nBLOCKED: this page is an anti-bot or access-denied wall, not the real content. Do not retry the same URL. " +
								"Use another source (web_search, web_extract, a different site) or tell the user the site blocks automation.",
						);
					}
				}
			}

			// D2 — estagnação: ação(ões) seguida(s) de página igual.
			if (ACTION_TOOLS.has(tool)) tracker.action();
			const state = stateOf(tool, call);
			if (state !== null) {
				const { stalled, level } = tracker.observe(tool === "browser_snapshot" ? "snapshot" : tool, state);
				if (stalled > lastStalled) metrics = { ...metrics, stalls: metrics.stalls + 1 };
				lastStalled = stalled;
				if (level === "hint") {
					notes.push(
						`\nSTALL: the page did not change after your last ${stalled} actions. Take a fresh browser_snapshot, try another ref, scroll, or switch to a connector/web_extract instead of repeating.`,
					);
				} else if (level === "strong") {
					notes.push(
						`\nSTALL: still no change after ${stalled} actions in a row. Change approach now (different element, web_extract/connector, another source) or tell the user what blocks you. One more unchanged result stops this run.`,
					);
				} else if (level === "abort") {
					abort = `Travei sem progresso: a página não mudou depois de ${stalled} ações seguidas.`;
				}
			}
			return { note: notes.join(""), abort, loginEvent };
		},
	};
}

export type ComputerGuard = ReturnType<typeof createComputerGuard>;
