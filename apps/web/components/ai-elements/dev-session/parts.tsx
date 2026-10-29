"use client";

import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

import type { DevTone } from "@/lib/dev-session/reducer";
import { useTranslations } from "@/lib/i18n/provider";

const DOT_CLASS: Record<DevTone, string> = {
	info: "bg-muted-foreground/60",
	working: "bg-success animate-pulse",
	idle: "bg-muted-foreground/40",
	done: "bg-muted-foreground/60",
	error: "bg-destructive",
};

/** Pílula neutra: só o ponto de status carrega significado. */
export function StatusPill({ tone, label, className }: { tone: DevTone; label: string; className?: string }) {
	return (
		<Badge className={cn("max-w-full truncate bg-muted font-medium text-foreground/80", className)} variant="ghost">
			<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} />
			<span className="truncate">{label}</span>
		</Badge>
	);
}

/** Copia `text` para a área de transferência; confirma com um check por 1,5 s. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
	const { t } = useTranslations();
	const shownLabel = label ?? t("devSession.parts.copy");
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return (
		<Button
			aria-label={copied ? t("devSession.parts.copied") : shownLabel}
			onClick={() => {
				void navigator.clipboard
					?.writeText(text)
					.then(() => {
						setCopied(true);
						if (timer.current) clearTimeout(timer.current);
						timer.current = setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => undefined);
			}}
			size="icon-xs"
			title={shownLabel}
			type="button"
			variant="ghost"
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}


/** Cartão compacto do chat: ícone, título e seta; abaixo, status · tempo (nunca cortado) e um detalhe que trunca. */
export function ActivityCard({
	icon,
	title,
	status,
	tone,
	extra,
	label,
	selected = false,
	onOpen,
	dataAttr,
}: {
	icon: React.ReactNode;
	title: string;
	status: string;
	tone: DevTone;
	extra?: React.ReactNode;
	label: string;
	selected?: boolean;
	onOpen?: () => void;
	dataAttr: "data-dev-session-card" | "data-subagent-card";
}) {
	return (
		<button
			{...{ [dataAttr]: true }}
			aria-label={label}
			aria-pressed={selected}
			className={cn(
				"group/row flex w-full max-w-[min(68ch,100%)] min-w-0 flex-col gap-1 self-start rounded-2xl bg-muted/60 px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
				selected && "bg-muted",
			)}
			onClick={onOpen}
			type="button"
		>
			<span className="flex min-w-0 items-center gap-2.5">
				<span
					aria-hidden="true"
					className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5"
				>
					{icon}
				</span>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
				<ChevronRightIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/row:translate-x-0.5"
				/>
			</span>
			<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
				<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])} />
				<span className="shrink-0 tabular-nums" data-dev-timer>
					{status}
				</span>
				{extra ? (
					<>
						<span aria-hidden="true" className="shrink-0">
							·
						</span>
						<span className="min-w-0 truncate" data-dev-extra>
							{extra}
						</span>
					</>
				) : null}
			</span>
		</button>
	);
}
