import type { ChatTool } from "@workspace/llm";

// F12/C4 — função `computer` com o vocabulário de ações de computer use
// (Claude/OpenAI), traduzida para as tools que o control server já entende.

export const NATIVE_COMPUTER_TOOL_NAME = "computer";

/** Tools de coordenada que o `computer` substitui quando está ligado. */
export const NATIVE_REPLACED_TOOLS: ReadonlySet<string> = new Set([
	"screenshot",
	"click",
	"type",
	"key",
	"scroll",
]);

export const NATIVE_COMPUTER_TOOL: ChatTool = {
	type: "function",
	function: {
		name: NATIVE_COMPUTER_TOOL_NAME,
		description:
			"Control the VM screen like a person: look and act by pixel coordinates of the LAST screenshot you received. Actions: screenshot, left_click, double_click, type, key, scroll, zoom, wait. USE for canvas, visual checks and apps outside the browser; for web pages prefer `browser_snapshot` + `browser_act` (cheaper and exact). Take a `screenshot` first, verify each action's result, never type passwords.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["screenshot", "left_click", "double_click", "type", "key", "scroll", "zoom", "wait"],
				},
				coordinate: {
					type: "array",
					items: { type: "number" },
					description: "[x, y] in the last screenshot image (left_click, double_click)",
				},
				text: { type: "string", description: "Text for `type`, key combo for `key` (e.g. ctrl+s, Return)" },
				scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
				scroll_amount: { type: "number", description: "Wheel notches (default 3)" },
				region: {
					type: "array",
					items: { type: "number" },
					description: "[x1, y1, x2, y2] in the last screenshot image (zoom)",
				},
				duration: { type: "number", description: "Seconds to wait (wait; max 20)" },
			},
			required: ["action"],
		},
	},
};

export type NativeStep = { name: string; args: Record<string, unknown> };

const PIXELS_PER_NOTCH = 120;
const UNSUPPORTED = new Set([
	"right_click",
	"middle_click",
	"triple_click",
	"mouse_move",
	"left_click_drag",
	"left_mouse_down",
	"left_mouse_up",
	"hold_key",
	"cursor_position",
]);

function pair(value: unknown, field: string): [number, number] {
	if (!Array.isArray(value) || value.length < 2) {
		throw new Error(`${field} inválido: use [x, y] da última screenshot`);
	}
	const a = Number(value[0]);
	const b = Number(value[1]);
	if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
		throw new Error(`${field} inválido: use números >= 0`);
	}
	return [a, b];
}

/** Traduz uma ação `computer` em chamadas das tools existentes (puro). */
export function translateNativeComputerAction(args: Record<string, unknown>): NativeStep[] {
	const action = String(args.action ?? "");
	if (UNSUPPORTED.has(action)) {
		throw new Error(
			`ação ${action} não é suportada nesta VM. Use left_click/double_click/type/key/scroll, ou browser_act por ref.`,
		);
	}
	switch (action) {
		case "screenshot":
			return [{ name: "screenshot", args: {} }];
		case "left_click":
		case "double_click": {
			const [x, y] = pair(args.coordinate, "coordinate");
			const click: NativeStep = { name: "click", args: { x, y } };
			return action === "double_click" ? [click, click] : [click];
		}
		case "type": {
			const text = String(args.text ?? "");
			if (!text) throw new Error("type exige `text`");
			return [{ name: "type", args: { text } }];
		}
		case "key": {
			const combo = String(args.text ?? "").trim();
			if (!combo) throw new Error("key exige `text` com a tecla (ex.: ctrl+s)");
			return [{ name: "key", args: { combo } }];
		}
		case "scroll": {
			const direction = String(args.scroll_direction ?? "down");
			const amount = args.scroll_amount === undefined ? 3 : Number(args.scroll_amount);
			if (!["up", "down", "left", "right"].includes(direction)) {
				throw new Error("scroll_direction inválido: use up, down, left ou right");
			}
			if (!Number.isFinite(amount) || amount <= 0 || amount > 50) {
				throw new Error("scroll_amount inválido: use um número entre 1 e 50");
			}
			const delta = Math.round(amount) * PIXELS_PER_NOTCH;
			const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
			const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;
			return [{ name: "scroll", args: { deltaX, deltaY } }];
		}
		case "zoom": {
			if (!Array.isArray(args.region) || args.region.length < 4) {
				throw new Error("zoom exige region [x1, y1, x2, y2] da última screenshot");
			}
			const [x1, y1, x2, y2] = args.region.map(Number) as [number, number, number, number];
			if (![x1, y1, x2, y2].every(Number.isFinite) || x2 - x1 < 8 || y2 - y1 < 8) {
				throw new Error("region inválida: precisa de pelo menos 8x8 px");
			}
			return [{ name: "screenshot", args: { region: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } } }];
		}
		case "wait": {
			const seconds = args.duration === undefined ? 2 : Number(args.duration);
			if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("duration inválido: use segundos > 0");
			return [{ name: "browser_wait", args: { for: "stable", timeout_ms: Math.min(20, seconds) * 1000 } }];
		}
		default:
			throw new Error(
				"action inválida: use screenshot, left_click, double_click, type, key, scroll, zoom ou wait",
			);
	}
}

/** Linha de prompt (inglês) quando o `computer` substitui as tools de coordenada. */
export const NATIVE_COMPUTER_PROMPT_LINE =
	"- Pixel actions go through the single `computer` tool (screenshot, left_click, type, key, scroll, zoom, wait); coordinates are those of the latest screenshot.";
