"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { copyFieldText } from "./routine-actions";

export const KEY_TOOLTIP =
	'Os remetentes se autenticam com este segredo: inclua o cabeçalho "X-Atlas-Hook-Secret: <segredo>" na solicitação do webhook';

/** Cabeçalho que o remetente envia (o segredo vai no cabeçalho, nunca na URL). */
export function hookSecretHeader(secret: string): string {
	return `X-Atlas-Hook-Secret: ${secret}`;
}

/** Campo somente leitura: clicar seleciona o texto, copia e mostra "Copiado". */
export function CopyField({
	label,
	value,
	placeholder,
	labelHint,
}: {
	label: string;
	value?: string | null;
	placeholder: string;
	labelHint?: string;
}) {
	const [copied, setCopied] = useState(false);
	const codeRef = useRef<HTMLElement | null>(null);
	const timer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timer.current) window.clearTimeout(timer.current);
		},
		[],
	);

	async function handleCopy() {
		if (!value) return;
		const node = codeRef.current;
		if (node && typeof window !== "undefined") {
			const selection = window.getSelection();
			const range = document.createRange();
			range.selectNodeContents(node);
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		const ok = await copyFieldText(value, navigator.clipboard?.writeText?.bind(navigator.clipboard));
		if (!ok) return;
		setCopied(true);
		if (timer.current) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div
			className="grid min-w-0 grid-cols-[minmax(0,1fr)_3rem] items-center gap-x-2 gap-y-1 sm:grid-cols-[4.5rem_minmax(0,1fr)_3rem]"
			data-webhook-field={label}
		>
			<span className="col-span-2 min-w-0 break-words text-caption text-muted-foreground sm:col-span-1">
				{labelHint ? (
					<Tooltip>
						<TooltipTrigger
							className="cursor-help underline decoration-dotted underline-offset-2"
							type="button"
						>
							{label}
						</TooltipTrigger>
						<TooltipContent>{labelHint}</TooltipContent>
					</Tooltip>
				) : (
					label
				)}
			</span>
			<button
				aria-label={value ? `Copiar ${label}` : undefined}
				className={cn(
					"w-full min-w-0 rounded-md bg-muted px-2 py-1 text-left text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring",
					value ? "cursor-pointer" : "cursor-default text-muted-foreground",
				)}
				disabled={!value}
				onClick={() => void handleCopy()}
				type="button"
			>
				<code className="block truncate" ref={codeRef}>
					{value || placeholder}
				</code>
			</button>
			<span aria-live="polite" className="w-12 min-w-0 truncate text-muted-foreground text-xs">
				{copied ? "Copiado" : ""}
			</span>
		</div>
	);
}

export function WebhookSection({
	url,
	secret,
	canRotate,
	onRotate,
	urlSecretAt,
}: {
	url?: string;
	secret?: string | null;
	/** A integração autenticou com ?secret= recentemente. */
	urlSecretAt?: string | null;
	canRotate: boolean;
	onRotate?: () => void | Promise<void>;
}) {
	const [rotating, setRotating] = useState(false);
	useEffect(() => {
		if (secret) setRotating(false);
	}, [secret]);

	async function handleRotate() {
		if (!onRotate) return;
		setRotating(true);
		try {
			await onRotate();
		} finally {
			setRotating(false);
		}
	}

	const keyPlaceholder = rotating ? "Gerando…" : "Segredo oculto — gere um novo";
	return (
		<div className="flex min-w-0 flex-col gap-3 sm:gap-2">
			<CopyField label="POST para" placeholder="Carregando…" value={url} />
			<CopyField
				label="segredo"
				labelHint={KEY_TOOLTIP}
				placeholder={keyPlaceholder}
				value={secret}
			/>
			<CopyField
				label="cabeçalho"
				placeholder="X-Atlas-Hook-Secret: <segredo>"
				value={secret ? hookSecretHeader(secret) : null}
			/>
			<p className="break-words text-muted-foreground text-xs">
				A URL não leva o segredo. Para ligar ao n8n ou similar, peça ao bot: ele usa o segredo por referência, sem você copiar nada.
			</p>
			{urlSecretAt ? (
				<p className="break-words rounded-xl bg-amber-500/10 p-2 text-xs" data-url-secret-warning>
					Esta integração usa o segredo na URL (?secret=). Prefira o cabeçalho X-Atlas-Hook-Secret.
				</p>
			) : null}
			{secret ? (
				<p className="break-words font-medium text-xs">
					Copie agora — não aparece de novo.
				</p>
			) : null}
			{canRotate && onRotate ? (
				<div className="min-w-0 space-y-1">
					<Button
						disabled={rotating}
						onClick={() => void handleRotate()}
						size="sm"
						variant="outline"
					>
						{rotating ? "Gerando…" : "Gerar novo segredo"}
					</Button>
					<p className="break-words text-muted-foreground text-xs">
						O segredo anterior deixa de funcionar.
					</p>
				</div>
			) : null}
		</div>
	);
}
