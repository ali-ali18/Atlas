"use client";

import { useEffect, useRef, useState } from "react";
import {
	ClipboardPasteIcon,
	KeyboardIcon,
	Minimize2Icon,
	RotateCwIcon,
} from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { sendSandboxKey, sendSandboxText } from "@/lib/atlas-api";
import type { AgentPointerState } from "@/lib/agent-pointer";
import { AgentAvatar } from "./agent-avatar";
import { AgentPointerOverlay } from "./agent-pointer-overlay";

/** id do campo oculto do noVNC (vnc.html 1.3, Debian bookworm) que vira teclas. */
const NOVNC_KEYBOARD_INPUT_ID = "noVNC_keyboardinput";

// Desktop (largura >= 640 e altura >= 520): cartão 16:9 centralizado; abaixo disso, tela cheia.
// As classes ficam escritas por extenso (o Tailwind não enxerga strings montadas).

/** Id da sessão embutido na URL do viewer em modo proxy (`/v1/sandbox/sessions/:id/viewer/...`). */
export function viewerSessionId(viewerUrl: string): string | null {
	const match = /\/v1\/sandbox\/sessions\/([^/]+)\/viewer\//.exec(viewerUrl);
	return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Foca o campo de teclado do próprio noVNC (mesma origem), o que abre o
 * teclado do celular. Devolve false se o iframe é de outra origem ou o campo
 * não existe; aí o diálogo usa a barra de digitação própria.
 */
export function focusNoVncKeyboard(iframe: HTMLIFrameElement | null): boolean {
	try {
		const input = iframe?.contentDocument?.getElementById(NOVNC_KEYBOARD_INPUT_ID);
		if (!input) return false;
		input.focus();
		return true;
	} catch {
		return false;
	}
}

const DESKTOP_QUERY = "(min-width: 640px) and (min-height: 520px)";

/** Desktop = cartão 16:9; abaixo disso (celular) é tela cheia com teclado e colar. */
function readDesktop(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia(DESKTOP_QUERY).matches
		: false;
}

/** Acompanha o breakpoint em JS: teclado e colar só EXISTEM no celular. */
export function useIsDesktopViewer(override?: boolean): boolean {
	const [desktop, setDesktop] = useState(() => override ?? readDesktop());
	useEffect(() => {
		if (override !== undefined || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(DESKTOP_QUERY);
		const update = () => setDesktop(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, [override]);
	return override ?? desktop;
}

/**
 * URL do viewer sem o token efêmero (`?t=` dentro de `path=`). Cada consulta à
 * API assina um token novo; comparar a URL inteira recarregava o iframe (e o
 * noVNC mostrava "Reconectando") a cada poll de 15 s.
 */
export function viewerUrlIdentity(viewerUrl: string): string {
	try {
		const url = new URL(viewerUrl, "http://viewer.invalid");
		const path = url.searchParams.get("path");
		if (path) url.searchParams.set("path", path.replace(/\?t=[^&]*/, ""));
		return `${url.pathname}${url.search}`;
	} catch {
		return viewerUrl;
	}
}

// Botões pequenos e translúcidos sobre os cantos da tela. Cada um é absoluto
// por conta própria: nenhuma camada cobre a VM e rouba o ponteiro.
const overlayBase = `absolute z-10 grid place-items-center rounded-full border border-white/15 bg-black/40 text-white/80 opacity-70 backdrop-blur-sm transition hover:bg-black/70 hover:text-white hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-pressed:bg-black/80`;
const overlayButton = `${overlayBase} size-8`;
const mobileOverlayButton = `${overlayBase} bottom-[max(0.75rem,env(safe-area-inset-bottom))] size-11`;
const topInset = "top-[max(0.5rem,env(safe-area-inset-top))] sm:top-2";

/**
 * Tela ao vivo da VM em tela cheia, na mesma página (sem aba nova). Fecha com
 * Esc ou pelo botão; quando aberta por um card de login, "Terminei" fica no
 * canto da tela. Sem cabeçalho: só botões pequenos e translúcidos sobre os
 * cantos; teclado e colar existem apenas no celular.
 */
export function SandboxViewerDialog({
	agentPointer = null,
	botName,
	botColor,
	viewerUrl,
	reloadKey,
	onClose,
	onReload,
	onFinish,
	desktop: desktopOverride,
}: {
	/** Cursor do agente desenhado sobre a tela ao vivo. */
	agentPointer?: AgentPointerState | null;
	botName: string;
	/** Cor do bot (hex), usada no avatar e no cursor do agente. */
	botColor?: string;
	viewerUrl: string;
	reloadKey: number;
	onClose: () => void;
	onReload: () => void;
	/** Presente quando a VM foi aberta por um card de login/captcha. */
	onFinish?: () => void;
	/** Força o layout (testes/preview); por padrão segue o tamanho da janela. */
	desktop?: boolean;
}) {
	const desktop = useIsDesktopViewer(desktopOverride);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [typingBar, setTypingBar] = useState(false);
	const [draft, setDraft] = useState("");
	const [sendError, setSendError] = useState<string | null>(null);
	const sessionId = viewerSessionId(viewerUrl);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const openKeyboard = () => {
		// Precisa rodar dentro do clique (gesto do usuário) para o teclado abrir.
		if (focusNoVncKeyboard(iframeRef.current)) {
			setTypingBar(false);
			return;
		}
		setTypingBar((open) => !open);
	};

	const send = async (action: (id: string) => Promise<void>) => {
		if (!sessionId) {
			setSendError("Não foi possível enviar para a VM.");
			return;
		}
		try {
			setSendError(null);
			await action(sessionId);
		} catch {
			setSendError("Não foi possível enviar para a VM.");
		}
	};

	const submitDraft = () => {
		const text = draft;
		setDraft("");
		if (text) void send((id) => sendSandboxText(id, text));
	};

	// Cola na VM o texto da área de transferência do usuário; sem permissão (ou
	// sem a API) cai na barra de digitação, onde ele cola e envia.
	const pasteClipboard = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (!text) throw new Error("empty");
			setTypingBar(false);
			await send((id) => sendSandboxText(id, text));
		} catch {
			setTypingBar(true);
		}
	};

	return (
		<div
			aria-label={`Tela do sandbox de ${botName}`}
			aria-modal="true"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 supports-backdrop-filter:backdrop-blur-sm [@media(min-width:640px)_and_(min-height:520px)]:p-6"
			role="dialog"
		>
			<button
				aria-label="Fechar tela do sandbox"
				className="absolute inset-0 cursor-default"
				onClick={onClose}
				type="button"
			/>
			<div className="relative flex h-dvh w-dvw flex-col overflow-hidden bg-black pb-[env(safe-area-inset-bottom)] [@media(min-width:640px)_and_(min-height:520px)]:h-auto [@media(min-width:640px)_and_(min-height:520px)]:w-[min(94vw,calc((100dvh-4rem)*16/9))] [@media(min-width:640px)_and_(min-height:520px)]:rounded-xl [@media(min-width:640px)_and_(min-height:520px)]:border [@media(min-width:640px)_and_(min-height:520px)]:border-white/10 [@media(min-width:640px)_and_(min-height:520px)]:pb-0">
				<div className="relative flex min-h-0 flex-1 items-center justify-center [@media(min-width:640px)_and_(min-height:520px)]:block [@media(min-width:640px)_and_(min-height:520px)]:flex-none">
					<div className="relative aspect-video w-[min(100vw,calc(100dvh*16/9))] [@media(min-width:640px)_and_(min-height:520px)]:w-full">
						<iframe
							allow="clipboard-read; clipboard-write"
							className="absolute inset-0 h-full w-full bg-black"
							key={reloadKey}
							ref={iframeRef}
							src={viewerUrl}
							title={`Sandbox de ${botName}`}
						/>
						<AgentPointerOverlay botName={botName} color={botColor} pointer={agentPointer} />
					</div>
					<button
						aria-label="Fechar tela do sandbox"
						className={`${overlayButton} ${topInset} left-2`}
						onClick={onClose}
						type="button"
					>
						<Minimize2Icon className="size-4" />
					</button>
					<button
						aria-label="Recarregar tela do sandbox"
						className={`${overlayButton} ${topInset} right-2`}
						onClick={onReload}
						type="button"
					>
						<RotateCwIcon className="size-4" />
					</button>
					{onFinish ? (
						<Button
							aria-label="Terminei o login, continuar a tarefa"
							className={`absolute right-12 z-10 rounded-full bg-black/50 backdrop-blur-sm ${topInset}`}
							onClick={onFinish}
							size="xs"
							type="button"
							variant="secondary"
						>
							Terminei
						</Button>
					) : null}
					{desktop ? null : (
						<>
							<button
								aria-label="Colar texto na VM"
								className={`${mobileOverlayButton} left-3`}
								onClick={() => void pasteClipboard()}
								type="button"
							>
								<ClipboardPasteIcon className="size-5" />
							</button>
							<button
								aria-label="Abrir o teclado"
								aria-pressed={typingBar}
								className={`${mobileOverlayButton} right-3`}
								onClick={openKeyboard}
								type="button"
							>
								<KeyboardIcon className="size-5" />
							</button>
						</>
					)}
				</div>

				{typingBar && !desktop ? (
					<form
						className="flex shrink-0 items-center gap-2 bg-zinc-950 px-2 py-2"
						onSubmit={(event) => {
							event.preventDefault();
							submitDraft();
						}}
					>
						<input
							aria-label="Texto para digitar na VM"
							autoCapitalize="off"
							autoComplete="off"
							autoCorrect="off"
							className="min-w-0 flex-1 rounded-md border border-white/20 bg-white/10 px-3 py-2 text-base text-white placeholder:text-white/50"
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Backspace" && draft === "") {
									void send((id) => sendSandboxKey(id, "BackSpace"));
								}
							}}
							placeholder="Digite ou cole aqui para enviar à VM"
							spellCheck={false}
							type="text"
							value={draft}
						/>
						<Button size="sm" type="submit" variant="secondary">
							Enviar
						</Button>
						<Button
							aria-label="Enter na VM"
							onClick={() => void send((id) => sendSandboxKey(id, "Return"))}
							size="sm"
							type="button"
							variant="secondary"
						>
							Enter
						</Button>
					</form>
				) : null}
				{typingBar && !desktop && sendError ? (
					<p className="shrink-0 bg-zinc-950 px-3 pb-2 text-xs text-red-300" role="alert">
						{sendError}
					</p>
				) : null}
			</div>
		</div>
	);
}
