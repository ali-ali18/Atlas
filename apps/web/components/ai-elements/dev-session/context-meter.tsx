"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@workspace/ui/components/popover";
import { cn } from "@workspace/ui/lib/utils";

import { formatTokens } from "@/lib/dev-session/actions";
import type { DevContextUsageView } from "@/lib/dev-session/reducer";

/** Percentuais inteiros (0-100) do uso e do ponto em que o contexto é resumido. */
export function contextMeterModel(usage: Pick<DevContextUsageView, "usedTokens" | "windowTokens" | "compactAtTokens">) {
	const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
	const used = clamp((usage.usedTokens / usage.windowTokens) * 100);
	const compactAt = clamp((usage.compactAtTokens / usage.windowTokens) * 100);
	return {
		used,
		compactAt,
		/** Perto do resumo automático (>= 70% do ponto de resumo): o anel ganha um tom âmbar discreto. */
		warn: usage.usedTokens >= usage.compactAtTokens * 0.7,
		title: `Contexto ${used}%`,
		detail: `${formatTokens(usage.usedTokens)} de ${formatTokens(usage.windowTokens)} tokens`,
		compactNote: `Resume automaticamente em ${compactAt}%`,
	};
}

const SIZE = 20;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Anel de progresso neutro (preenche no sentido horário) com popover de detalhes. */
export function ContextMeter({ usage }: { usage: DevContextUsageView }) {
	const model = contextMeterModel(usage);
	return (
		<Popover>
			<PopoverTrigger
				aria-label={`${model.title}. ${model.detail}. ${model.compactNote}`}
				className="inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full pr-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				data-context-meter
				data-warn={model.warn ? "true" : undefined}
				openOnHover
			>
				<svg aria-hidden className="-rotate-90" height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE}>
					<circle className="stroke-muted-foreground/25" cx={SIZE / 2} cy={SIZE / 2} fill="none" r={RADIUS} strokeWidth={STROKE} />
					<circle
						className={cn("transition-[stroke-dashoffset] duration-300", model.warn ? "stroke-warning" : "stroke-muted-foreground")}
						cx={SIZE / 2}
						cy={SIZE / 2}
						fill="none"
						r={RADIUS}
						strokeDasharray={CIRCUMFERENCE}
						strokeDashoffset={CIRCUMFERENCE * (1 - model.used / 100)}
						strokeLinecap="round"
						strokeWidth={STROKE}
					/>
				</svg>
				<span aria-hidden className="text-muted-foreground text-xs tabular-nums" data-context-percent>{model.used}%</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-auto min-w-44 gap-0.5 p-3 text-xs" data-context-popover>
				<p className="font-medium text-sm">{model.title}</p>
				<p className="text-muted-foreground tabular-nums">{model.detail}</p>
				<p className="text-muted-foreground">{model.compactNote}</p>
			</PopoverContent>
		</Popover>
	);
}
