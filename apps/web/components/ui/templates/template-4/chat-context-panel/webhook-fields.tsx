"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { useT } from "@/lib/i18n/provider";
import { copyFieldText } from "./routine-actions";

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
	const t = useT();
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
				aria-label={value ? t("routines.hook.copyField", { label }) : undefined}
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
				{copied ? t("routines.hook.copied") : ""}
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
	const t = useT();
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

	const keyPlaceholder = rotating ? t("routines.hook.generating") : t("routines.hook.hiddenSecret");
	return (
		<div className="flex min-w-0 flex-col gap-3 sm:gap-2">
			<CopyField label={t("routines.hook.postTo")} placeholder={t("common.loading")} value={url} />
			<CopyField
				label={t("routines.hook.secret")}
				labelHint={t("routines.hook.secretHint")}
				placeholder={keyPlaceholder}
				value={secret}
			/>
			<CopyField
				label={t("routines.hook.header")}
				placeholder={t("routines.hook.headerPlaceholder")}
				value={secret ? hookSecretHeader(secret) : null}
			/>
			<p className="break-words text-muted-foreground text-xs">
				{t("routines.hook.urlNoSecret")}
			</p>
			{urlSecretAt ? (
				<p className="break-words rounded-xl bg-warning/10 p-2 text-xs" data-url-secret-warning>
					{t("routines.hook.urlSecretWarning")}
				</p>
			) : null}
			{secret ? (
				<p className="break-words font-medium text-xs">
					{t("routines.hook.copyNow")}
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
						{rotating ? t("routines.hook.generating") : t("routines.hook.rotate")}
					</Button>
					<p className="break-words text-muted-foreground text-xs">
						{t("routines.hook.rotateHelp")}
					</p>
				</div>
			) : null}
		</div>
	);
}
