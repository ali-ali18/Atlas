import type { AgentPointerEvent } from "@workspace/shared";

/** Depois deste tempo sem evento novo o cursor some. */
export const AGENT_POINTER_IDLE_MS = 3000;

export type Size = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Onde uma imagem `object-fit: contain` de `content` fica dentro de
 * `container` (as bordas pretas do letterbox ficam fora do retângulo).
 */
export function containRect(container: Size, content: Size): Rect | null {
	if (!(container.width > 0 && container.height > 0)) return null;
	if (!(content.width > 0 && content.height > 0)) return null;
	const scale = Math.min(container.width / content.width, container.height / content.height);
	const width = content.width * scale;
	const height = content.height * scale;
	return {
		left: (container.width - width) / 2,
		top: (container.height - height) / 2,
		width,
		height,
	};
}

/** Ponto da tela do sandbox (x,y em pixels reais) em pixels do container. */
export function pointerToContainer(
	point: { x: number; y: number },
	screen: Size,
	container: Size,
): { left: number; top: number } | null {
	const rect = containRect(container, screen);
	if (!rect) return null;
	const nx = Math.min(Math.max(point.x / screen.width, 0), 1);
	const ny = Math.min(Math.max(point.y / screen.height, 0), 1);
	return { left: rect.left + nx * rect.width, top: rect.top + ny * rect.height };
}

/** Estado exibido: o último ponto conhecido + o último rótulo. */
export type AgentPointerState = {
	action: AgentPointerEvent["action"];
	label: string;
	at: number;
	x?: number;
	y?: number;
	viewportW: number;
	viewportH: number;
	/** Muda a cada clique, para reiniciar a animação de ondulação. */
	clickSeq: number;
	/** Muda a cada evento, para reiniciar a contagem do fade. */
	seq: number;
};

/**
 * Aplica um evento ao estado. Evento sem coordenadas (digitar, rolar) mantém
 * onde o cursor estava, desde que a tela seja a mesma.
 */
export function reduceAgentPointer(
	previous: AgentPointerState | null,
	event: AgentPointerEvent,
): AgentPointerState {
	const sameScreen =
		previous !== null &&
		previous.viewportW === event.viewportW &&
		previous.viewportH === event.viewportH;
	const hasPoint = event.x !== undefined && event.y !== undefined;
	const keep = !hasPoint && sameScreen ? previous : null;
	return {
		action: event.action,
		label: event.label,
		at: event.at,
		x: hasPoint ? event.x : keep?.x,
		y: hasPoint ? event.y : keep?.y,
		viewportW: event.viewportW,
		viewportH: event.viewportH,
		clickSeq: (previous?.clickSeq ?? 0) + (event.action === "click" && hasPoint ? 1 : 0),
		seq: (previous?.seq ?? 0) + 1,
	};
}

/** Para onde abrir o rótulo para ele não sair da tela. */
export function labelAnchor(
	position: { left: number; top: number },
	container: Size,
): { horizontal: "left" | "right"; vertical: "above" | "below" } {
	return {
		horizontal: position.left > container.width * 0.6 ? "left" : "right",
		vertical: position.top > container.height * 0.85 ? "above" : "below",
	};
}

type Timers = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
};

/**
 * Agenda o fade por inatividade; devolve o cancelamento. Cada chamada nova
 * (outro evento) cancela a anterior e reinicia a contagem.
 */
export function scheduleIdleFade(
	onHide: () => void,
	ms: number = AGENT_POINTER_IDLE_MS,
	timers: Timers = {
		setTimeout: (fn, delay) => globalThis.setTimeout(fn, delay),
		clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
	},
): () => void {
	const id = timers.setTimeout(onHide, ms);
	return () => timers.clearTimeout(id);
}

/** Cor do cursor quando o bot não tem cor definida. */
export const AGENT_POINTER_FALLBACK_COLOR = "#f44336";

function parseHex(color: string): [number, number, number] | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!match) return null;
	const raw = match[1] ?? "";
	const hex = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
	return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
	const [lr, lg, lb] = [r, g, b].map((channel) => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** Contraste mínimo do branco (WCAG, texto grande/negrito) para preferi-lo. */
const WHITE_MIN_CONTRAST = 3;

/**
 * Texto legível sobre a cor do bot: branco (como no Figma) enquanto o
 * contraste for aceitável; senão quase preto. Cor inválida cai no branco.
 */
export function readableTextColor(background: string): "#ffffff" | "#111111" {
	const rgb = parseHex(background);
	if (!rgb) return "#ffffff";
	const contrastWhite = 1.05 / (relativeLuminance(rgb) + 0.05);
	return contrastWhite >= WHITE_MIN_CONTRAST ? "#ffffff" : "#111111";
}
