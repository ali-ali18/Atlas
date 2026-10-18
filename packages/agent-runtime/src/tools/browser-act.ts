import { redactSecrets } from "../mcp/sanitize.js";
import { formatBrowserClick, formatBrowserType } from "./computer-changes.js";
import type { ComputerToolContext, ComputerToolOutcome } from "./computer-refs.js";

// V6 — `browser_act` sem ref: clique por texto/seletor, digitação no campo em foco
// e rolagem. Absorve os antigos `browser_click`, `browser_type` e `scroll` do navegador.

const TEXT_MAX = 300;
const SELECTOR_MAX = 300;
const VALUE_MAX = 20_000;
const SCROLL_STEP = 600;
const SCROLL_EXTREME = 100_000;

/** Direção ou pixels (com sinal) -> deslocamento vertical. */
export function parseScrollValue(value: string | undefined): number {
	const raw = (value ?? "down").trim().toLowerCase();
	if (raw === "down") return SCROLL_STEP;
	if (raw === "up") return -SCROLL_STEP;
	if (raw === "bottom") return SCROLL_EXTREME;
	if (raw === "top") return -SCROLL_EXTREME;
	const pixels = Number(raw);
	if (!Number.isFinite(pixels) || pixels === 0) {
		throw new Error('scroll `value` must be down, up, top, bottom or a pixel count (e.g. 800 or -400)');
	}
	return Math.max(-SCROLL_EXTREME, Math.min(SCROLL_EXTREME, Math.round(pixels)));
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value);
	if (text.length > max) throw new Error(`${field} too long (max ${max} characters)`);
	return text.trim() ? text : undefined;
}

const NEEDS_REF = new Set(["select", "check", "uncheck", "hover", "press", "clear"]);

export async function executeTargetlessAct(
	args: Record<string, unknown>,
	ctx: Pick<ComputerToolContext, "manager" | "getSessionId">,
): Promise<ComputerToolOutcome> {
	const action = String(args.action ?? "");
	const text = optionalString(args.text, "text", TEXT_MAX);
	const selector = optionalString(args.selector, "selector", SELECTOR_MAX);
	const value = optionalString(args.value, "value", VALUE_MAX);

	if (action === "click") {
		if (!text && !selector) {
			throw new Error("click needs a `ref` (from browser_snapshot, browser_read or browser_find) or the element's visible `text`");
		}
		const result = await ctx.manager.execBrowserClick(await ctx.getSessionId(), { selector, text });
		return { summary: redactSecrets(formatBrowserClick(result)) };
	}
	if (action === "type") {
		if (!value) throw new Error("type needs `value` (the text to enter)");
		const submit = args.submit === true;
		const effect = await ctx.manager.execBrowserType(await ctx.getSessionId(), { selector, text: value, submit });
		return { summary: redactSecrets(formatBrowserType({ selector, submit }, effect)) };
	}
	if (action === "scroll") {
		const deltaY = parseScrollValue(value);
		const position = await ctx.manager.execScroll(await ctx.getSessionId(), 0, deltaY);
		const where =
			typeof position?.scrollY === "number"
				? `; position ${position.scrollY}${typeof position.scrollHeight === "number" ? `/${position.scrollHeight}` : ""}`
				: "";
		return { summary: `Scrolled ${deltaY > 0 ? "down" : "up"} ${Math.abs(deltaY)} px${where}` };
	}
	if (NEEDS_REF.has(action)) {
		throw new Error(`${action} needs a \`ref\` (from browser_snapshot, browser_read or browser_find)`);
	}
	throw new Error("invalid action: use click, type, select, check, uncheck, hover, press, clear or scroll");
}
