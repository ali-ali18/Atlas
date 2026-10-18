"use client";

import { useEffect, useRef, useState } from "react";
import {
	ArrowLeftIcon,
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

const toolbarButton = `grid size-10 shrink-0 place-items-center rounded-full border border-white/15 bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-pressed:bg-white/30 [@media(min-width:640px)_and_(min-height:520px)]:size-9 [@media(min-width:640px)_and_(min-height:520px)]:rounded-md`;
const floatingButton = `absolute bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 grid size-12 place-items-center rounded-full border border-white/15 bg-zinc-800/90 text-white shadow-lg backdrop-blur transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white aria-pressed:bg-zinc-600 [@media(min-width:640px)_and_(min-height:520px)]:hidden`;

/**
 * Tela ao vivo da VM em tela cheia, na mesma página (sem aba nova). Fecha com
 * Esc ou pelo botão; quando aberta por um card de login, "Terminei" fica no
 * cabeçalho (fora da VM) para o usuário concluir sem voltar ao chat.
 * No celular é uma folha preta: cabeçalho com voltar + bot, a VM em 16:9 na
 * largura toda e, embaixo, botões redondos de colar (esquerda) e teclado (direita).
 */
export function SandboxViewerDialog({
	agentPointer = null,
	botName,
	botColor,
	botId,
	botShape,
	viewerUrl,
	reloadKey,
	onClose,
	onReload,
	onFinish,
}: {
	/** Cursor do agente desenhado sobre a tela ao vivo. */
	agentPointer?: AgentPointerState | null;
	botName: string;
	/** Cor do bot (hex), usada no avatar e no cursor do agente. */
	botColor?: string;
	botId?: string;
	botShape?: string;
	viewerUrl: string;
	reloadKey: number;
	onClose: () => void;
	onReload: () => void;
	/** Presente quando a VM foi aberta por um card de login/captcha. */
	onFinish?: () => void;
}) {
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
			className={`fixed inset-0 z-50 flex items-center justify-center bg-black/80 supports-backdrop-filter:backdrop-blur-sm [@media(min-width:640px)_and_(min-height:520px)]:p-6`}
			role="dialog"
		>
			<button
				aria-label="Fechar tela do sandbox"
				className="absolute inset-0 cursor-default"
				onClick={onClose}
				type="button"
			/>
			<div
				className={`relative flex h-dvh w-dvw flex-col overflow-hidden bg-black pb-[env(safe-area-inset-bottom)] [@media(min-width:640px)_and_(min-height:520px)]:h-auto [@media(min-width:640px)_and_(min-height:520px)]:w-[min(94vw,calc((100dvh-7rem)*16/9))] [@media(min-width:640px)_and_(min-height:520px)]:rounded-xl [@media(min-width:640px)_and_(min-height:520px)]:border [@media(min-width:640px)_and_(min-height:520px)]:border-white/10 [@media(min-width:640px)_and_(min-height:520px)]:pb-0`}
			>
				<div
					className={`flex h-14 shrink-0 items-center gap-2 bg-black px-3 pt-[env(safe-area-inset-top)] [@media(min-width:640px)_and_(min-height:520px)]:h-auto [@media(min-width:640px)_and_(min-height:520px)]:bg-zinc-950 [@media(min-width:640px)_and_(min-height:520px)]:px-2 [@media(min-width:640px)_and_(min-height:520px)]:py-1.5 [@media(min-width:640px)_and_(min-height:520px)]:pt-1.5`}
				>
					<button
						aria-label="Fechar tela do sandbox"
						className={toolbarButton}
						onClick={onClose}
						type="button"
					>
						<ArrowLeftIcon className={`size-5 [@media(min-width:640px)_and_(min-height:520px)]:hidden`} />
						<Minimize2Icon className={`hidden size-4 [@media(min-width:640px)_and_(min-height:520px)]:block`} />
					</button>
					<span
						className={`flex min-w-0 items-center gap-2 font-medium text-sm text-white [@media(min-width:640px)_and_(min-height:520px)]:hidden`}
					>
						<AgentAvatar
							animated={false}
							bodyColor={botColor}
							id={botId}
							shape={botShape}
							size={28}
						/>
						<span className="truncate">{botName}</span>
					</span>
					<button
						aria-label="Recarregar tela do sandbox"
						className={`${toolbarButton} ml-auto [@media(min-width:640px)_and_(min-height:520px)]:ml-0`}
						onClick={onReload}
						type="button"
					>
						<RotateCwIcon className="size-4" />
					</button>
					<button
						aria-label="Abrir o teclado"
						aria-pressed={typingBar}
						className={`${toolbarButton} hidden [@media(min-width:640px)_and_(min-height:520px)]:grid`}
						onClick={openKeyboard}
						type="button"
					>
						<KeyboardIcon className="size-4" />
					</button>
					<button
						aria-label="Colar texto na VM"
						className={`${toolbarButton} hidden [@media(min-width:640px)_and_(min-height:520px)]:grid`}
						onClick={() => void pasteClipboard()}
						type="button"
					>
						<ClipboardPasteIcon className="size-4" />
					</button>
					{onFinish ? (
						<Button
							aria-label="Terminei o login, continuar a tarefa"
							className={`rounded-full [@media(min-width:640px)_and_(min-height:520px)]:ml-auto [@media(min-width:640px)_and_(min-height:520px)]:rounded-md`}
							onClick={onFinish}
							size="sm"
							type="button"
						>
							Terminei
						</Button>
					) : null}
				</div>
				<div
					className={`relative flex min-h-0 flex-1 items-center justify-center [@media(min-width:640px)_and_(min-height:520px)]:block [@media(min-width:640px)_and_(min-height:520px)]:flex-none`}
				>
					<div
						className={`relative aspect-video w-[min(100vw,calc((100dvh-3.5rem)*16/9))] [@media(min-width:640px)_and_(min-height:520px)]:w-full`}
					>
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
						aria-label="Colar texto na VM"
						className={`${floatingButton} left-4`}
						onClick={() => void pasteClipboard()}
						type="button"
					>
						<ClipboardPasteIcon className="size-5" />
					</button>
					<button
						aria-label="Abrir o teclado"
						aria-pressed={typingBar}
						className={`${floatingButton} right-4`}
						onClick={openKeyboard}
						type="button"
					>
						<KeyboardIcon className="size-5" />
					</button>
				</div>
				{typingBar ? (
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
				{typingBar && sendError ? (
					<p className="shrink-0 bg-zinc-950 px-3 pb-2 text-xs text-red-300" role="alert">
						{sendError}
					</p>
				) : null}
			</div>
		</div>
	);
}
