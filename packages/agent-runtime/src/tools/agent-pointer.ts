import type { ControlPointer, SandboxManager } from "@workspace/sandbox";
import {
	AGENT_POINTER_NAME_MAX,
	redactSecrets,
	type AgentPointerAction,
	type AgentPointerEvent,
} from "@workspace/shared";

/**
 * Cursor do agente: cada ação de navegador emite um `agent_pointer` para o
 * usuário ver onde o agente age. Entra como decorador do `SandboxManager`
 * (nenhuma tool muda) e é best effort: medir ou emitir nunca falha a ação.
 * O rótulo é pt-BR, curto e jamais carrega texto digitado.
 */

type Screen = { w: number; h: number };
type Emit = (event: AgentPointerEvent) => void | Promise<void>;
type PointerDraft = Omit<Parameters<typeof buildPointerEvent>[0], "at">;

/** Campo cujo nome sugere segredo: o rótulo vira só "Digitando…". */
const SENSITIVE_NAME =
	/senha|password|passwd|cvv|cvc|token|secret|segredo|otp|2fa|c[óo]digo de (verifica|seguran)|cart[ãa]o|card number|cpf|\bpin\b/i;

/** Nome de elemento pronto para o rótulo: sem espaços extras, sem segredo, até 40 chars. */
export function pointerName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const clean = redactSecrets(raw).replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return clean.length > AGENT_POINTER_NAME_MAX
		? `${clean.slice(0, AGENT_POINTER_NAME_MAX - 1)}…`
		: clean;
}

const quoted = (name: string) => `“${name}”`;

export function clickLabel(name: string | undefined): string {
	const safe = pointerName(name);
	return safe ? `Clicando em ${quoted(safe)}` : "Clicando";
}

/** Nunca recebe o texto digitado: só o nome do campo (e não o de campo sensível). */
export function typeLabel(fieldName: string | undefined, sensitive = false): string {
	const safe = pointerName(fieldName);
	if (sensitive || !safe || SENSITIVE_NAME.test(safe)) return "Digitando…";
	return `Digitando em ${quoted(safe)}`;
}

export function navigateLabel(url: string | undefined): string {
	if (!url) return "Abrindo página";
	try {
		const host = new URL(url).hostname.replace(/^www\./, "");
		return host ? `Abrindo ${host}` : "Abrindo página";
	} catch {
		return "Abrindo página";
	}
}

/** Monta o evento; x/y só entram se forem finitos e a tela for conhecida (senão não dá para escalar). */
export function buildPointerEvent(input: {
	action: AgentPointerAction;
	label: string;
	x?: number;
	y?: number;
	screen?: Screen | null;
	at?: number;
}): AgentPointerEvent {
	const w = input.screen?.w ?? 0;
	const h = input.screen?.h ?? 0;
	const hasPoint =
		w > 0 && h > 0 && Number.isFinite(input.x) && Number.isFinite(input.y);
	return {
		type: "agent_pointer",
		action: input.action,
		...(hasPoint
			? {
					x: Math.min(Math.max(0, Math.round(input.x!)), w),
					y: Math.min(Math.max(0, Math.round(input.y!)), h),
				}
			: {}),
		viewportW: w,
		viewportH: h,
		label: input.label,
		at: input.at ?? Date.now(),
	};
}

type Helpers = {
	screenOf: (sessionId: string) => Promise<Screen | null>;
	fire: (event: PointerDraft) => void;
};
type Handler = (args: unknown[], call: () => Promise<unknown>, helpers: Helpers) => Promise<unknown>;

function pointerOf(result: unknown): ControlPointer | undefined {
	const pointer = (result as { pointer?: ControlPointer } | null | undefined)?.pointer;
	return pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y) ? pointer : undefined;
}

/** Tela medida pelo servidor, ou a do `/screen` (só consultada se houver ponto). */
async function screenFor(
	pointer: ControlPointer | undefined,
	sessionId: unknown,
	helpers: Helpers,
): Promise<Screen | null> {
	if (!pointer) return null;
	if (pointer.screenW && pointer.screenH) return { w: pointer.screenW, h: pointer.screenH };
	return helpers.screenOf(String(sessionId));
}

const named = (verb: string, fallback: string) => (name: string | undefined) => {
	const safe = pointerName(name);
	return safe ? `${verb} ${quoted(safe)}` : fallback;
};

const ACT_LABELS: Record<string, (name: string | undefined, sensitive: boolean) => string> = {
	click: (name) => clickLabel(name),
	hover: named("Passando o mouse em", "Movendo o cursor"),
	type: (name, sensitive) => typeLabel(name, sensitive),
	clear: () => "Limpando o campo",
	select: named("Selecionando em", "Selecionando uma opção"),
	check: named("Marcando", "Marcando uma opção"),
	uncheck: named("Desmarcando", "Desmarcando uma opção"),
	press: () => "Pressionando uma tecla",
};

function actAction(act: string): AgentPointerAction {
	if (act === "hover") return "move";
	if (act === "type" || act === "clear" || act === "press") return "type";
	return "click";
}

const HANDLERS: Record<string, Handler> = {
	async execNavigate([, url], call, { fire }) {
		fire({ action: "navigate", label: navigateLabel(String(url ?? "")) });
		return call();
	},
	async execClick([sessionId, x, y], call, { screenOf, fire }) {
		fire({
			action: "click",
			label: "Clicando",
			x: Number(x),
			y: Number(y),
			screen: await screenOf(String(sessionId)),
		});
		return call();
	},
	async execType(_args, call, { fire }) {
		fire({ action: "type", label: "Digitando…" });
		return call();
	},
	async execKey(_args, call, { fire }) {
		fire({ action: "type", label: "Pressionando uma tecla" });
		return call();
	},
	async execScroll(_args, call, { fire }) {
		fire({ action: "scroll", label: "Rolando a página" });
		return call();
	},
	async execBrowserClick([sessionId, params], call, helpers) {
		const result = await call();
		const pointer = pointerOf(result);
		const asked = (params as { text?: string } | undefined)?.text;
		helpers.fire({
			action: "click",
			label: pointer?.sensitive ? "Clicando" : clickLabel(pointer?.name ?? asked),
			x: pointer?.x,
			y: pointer?.y,
			screen: await screenFor(pointer, sessionId, helpers),
		});
		return result;
	},
	async execBrowserType([sessionId], call, helpers) {
		const result = await call();
		const pointer = pointerOf(result);
		helpers.fire({
			action: "type",
			label: typeLabel(pointer?.name, pointer?.sensitive === true),
			x: pointer?.x,
			y: pointer?.y,
			screen: await screenFor(pointer, sessionId, helpers),
		});
		return result;
	},
	async execBrowserAct([sessionId, params], call, helpers) {
		const result = await call();
		const pointer = pointerOf(result);
		const act = String((params as { action?: string } | undefined)?.action ?? "click");
		const field = (result as { field?: { secret?: boolean } } | null)?.field;
		const sensitive = pointer?.sensitive === true || field?.secret === true;
		const label = (ACT_LABELS[act] ?? ACT_LABELS.click!)(sensitive ? undefined : pointer?.name, sensitive);
		helpers.fire({
			action: actAction(act),
			label,
			x: pointer?.x,
			y: pointer?.y,
			screen: await screenFor(pointer, sessionId, helpers),
		});
		return result;
	},
};

/**
 * Decora o manager: as ações de navegador emitem `agent_pointer`. Métodos que
 * o manager não tem (mocks parciais) passam direto. `emit` pode ser assíncrono;
 * seus erros são engolidos.
 */
export function withAgentPointer<M extends SandboxManager>(
	manager: M,
	emit: Emit,
	options: { now?: () => number } = {},
): M {
	const now = options.now ?? Date.now;
	const screens = new Map<string, Screen>();

	const screenOf = async (inner: SandboxManager, sessionId: string): Promise<Screen | null> => {
		const known = screens.get(sessionId);
		if (known) return known;
		try {
			const size = await inner.execScreen(sessionId);
			if (!(size.width > 0 && size.height > 0)) return null;
			const screen = { w: size.width, h: size.height };
			screens.set(sessionId, screen);
			return screen;
		} catch {
			return null; // sem tela conhecida o evento sai sem x/y
		}
	};

	const fire = (draft: PointerDraft) => {
		try {
			const pending = emit(buildPointerEvent({ ...draft, at: now() }));
			if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
		} catch {
			// o cursor é só cortesia visual
		}
	};

	const wrap = (inner: M): M =>
		new Proxy(inner, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") return value;
				if (prop === "withExecutionContext") {
					return (context: unknown) => {
						const next = (value as (c: unknown) => M).call(target, context);
						return next ? wrap(next) : next;
					};
				}
				const handler = typeof prop === "string" ? HANDLERS[prop] : undefined;
				if (!handler) return value;
				return (...args: unknown[]) =>
					handler(
						args,
						() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
						{ screenOf: (sessionId) => screenOf(target, sessionId), fire },
					);
			},
		});

	return wrap(manager);
}
