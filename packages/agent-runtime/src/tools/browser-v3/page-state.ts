import type { ControlPageState } from "@workspace/sandbox";
import { detectCaptchaWall, hasOneTimeCodeField, hasPasswordField } from "@workspace/shared";

/**
 * `page_state` (harness v3, desenho 5): loading | login_wall | consent | challenge | error | ok. A VM nova calcula
 * pelo DOM e manda `pageState`; imagem antiga não manda e o runtime calcula pelo que já tem (snapshot, URL, título).
 * Determinístico: sinais estruturais, sem LLM e sem ler a fala do usuário ou do modelo.
 */
export type PageStateName = ControlPageState["state"];
export type PageStateInfo = ControlPageState;

export type PageStateInput = {
	url?: string;
	title?: string;
	/** Linhas acionáveis do snapshot (`textbox "Senha" [a3] (campo de senha: ...)`). */
	lines?: readonly string[];
	/** Árvore renderizada (pode ter só um pedaço da página). */
	tree?: string;
	/** Tamanho do texto da página, quando o servidor informa. */
	textLength?: number;
	/** O servidor (VM nova) já calculou. */
	fromServer?: ControlPageState;
};

const ERROR_TITLE = /^(?:error\s*)?(?:4\d\d|5\d\d)\b|\bnot found\b|\bforbidden\b|\bbad gateway\b|\bservice unavailable\b/i;
const CONSENT_DIALOG = /\b(?:dialog|alertdialog)\b[^\n]*\b(?:cookie|cookies|consent|gdpr|privacy|privacidade|consentimento)\b/i;

/** Estado da página: o da VM quando veio, senão o derivado do snapshot. */
export function derivePageState(input: PageStateInput): PageStateInfo {
	if (input.fromServer) return input.fromServer;
	const lines = input.lines ?? [];
	const tree = input.tree ?? "";
	const all = tree ? [...lines, ...tree.split("\n")] : lines;
	if (input.url && detectCaptchaWall({ url: input.url, ...(input.title ? { title: input.title } : {}), lines: all.slice(0, 80) })) {
		return { state: "challenge", reason: "a human-verification challenge (captcha) is on the page" };
	}
	if (input.title && ERROR_TITLE.test(input.title.trim())) return { state: "error", reason: "the page title looks like an error page" };
	if (hasPasswordField(all)) return { state: "login_wall", reason: "a password field is visible" };
	if (hasOneTimeCodeField(all)) return { state: "login_wall", reason: "a one-time-code field is visible" };
	if (all.some((line) => CONSENT_DIALOG.test(line))) return { state: "consent", reason: "a cookie/consent dialog is open" };
	// Só vale com snapshot na mão: sem ele (ex.: logo após navegar) não há como saber se está vazia.
	const seen = input.lines !== undefined || input.tree !== undefined;
	if (seen && all.filter((line) => line.trim()).length === 0 && (input.textLength ?? 0) < 40) return { state: "loading", reason: "the page is still empty (rendering?)" };
	return { state: "ok" };
}

const HINTS: Record<Exclude<PageStateName, "ok">, string> = {
	loading: "wait for it (browser_act with a wait action, or look again) before concluding the page is empty.",
	login_wall: "never type credentials; a login card asks the user (or use login_fill with a saved login).",
	consent: "close or reject the banner (never accept) if it covers what you need.",
	challenge: "do not try to solve it; a card asks the user, otherwise use another source.",
	error: "the page failed to load; try another URL or source.",
};

/** Linha para o modelo; vazia quando está tudo bem (economiza tokens no caso comum). */
export function formatPageState(info: PageStateInfo | undefined): string {
	if (!info || info.state === "ok") return "";
	return `page_state: ${info.state}${info.reason ? ` (${info.reason})` : ""} — ${HINTS[info.state]}`;
}
