"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@workspace/ui/lib/utils";
import {
	AGENT_POINTER_FALLBACK_COLOR,
	AGENT_POINTER_IDLE_MS,
	labelAnchor,
	pointerToContainer,
	readableTextColor,
	scheduleIdleFade,
	type AgentPointerState,
	type Size,
} from "@/lib/agent-pointer";

/**
 * Etiqueta do cursor no estilo multiplayer: nome do bot em destaque seguido
 * da ação atual, na cor do bot, com o texto na cor de maior legibilidade.
 */
function NameTag({
	botName,
	color,
	label,
	className,
}: {
	botName: string;
	color: string;
	label: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"absolute flex max-w-[16rem] items-baseline gap-1 rounded-full px-2.5 py-1 text-[11px] leading-none whitespace-nowrap shadow-md ring-1 ring-white/70",
				className,
			)}
			data-agent-label=""
			style={{ backgroundColor: color, color: readableTextColor(color) }}
		>
			<span className="shrink-0 font-semibold">{botName}</span>
			{label ? (
				<>
					<span aria-hidden="true" className="shrink-0 opacity-60">
						·
					</span>
					<span className="min-w-0 truncate font-normal">{label}</span>
				</>
			) : null}
		</span>
	);
}

/**
 * Camada visual do cursor do agente: seta na cor do bot que desliza até o
 * ponto, ondulação no clique e a etiqueta com o nome e o que ele faz agora.
 * Só desenha; quem mede o container e controla o fade é o `AgentPointerOverlay`.
 */
export function AgentPointerLayer({
	pointer,
	container,
	visible,
	botName = "Atlas",
	color = AGENT_POINTER_FALLBACK_COLOR,
}: {
	pointer: AgentPointerState;
	container: Size;
	visible: boolean;
	botName?: string;
	/** Cor do bot (hex): seta, ondulação e etiqueta. */
	color?: string;
}) {
	const position =
		pointer.x !== undefined && pointer.y !== undefined
			? pointerToContainer(
					{ x: pointer.x, y: pointer.y },
					{ width: pointer.viewportW, height: pointer.viewportH },
					container,
				)
			: null;
	const anchor = position ? labelAnchor(position, container) : null;

	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-500 motion-reduce:transition-none",
				visible ? "opacity-100" : "opacity-0",
			)}
			data-agent-pointer={visible ? "visible" : "hidden"}
		>
			{position ? (
				<div
					className="absolute z-10 transition-[left,top] duration-300 ease-[cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none"
					data-agent-cursor=""
					style={{ left: position.left, top: position.top }}
				>
					{pointer.clickSeq > 0 && pointer.action === "click" ? (
						<span
							className="absolute -top-3 -left-3 size-6 animate-ping rounded-full border-2 motion-reduce:animate-none"
							data-agent-ripple=""
							key={pointer.clickSeq}
							style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
						/>
					) : null}
					<svg
						className="relative size-6 -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_2px_3px_rgba(0,0,0,0.35)]"
						data-agent-arrow=""
						viewBox="0 0 24 24"
					>
						<path
							d="M3 2v16.2l4.3-4 3 6.8 2.7-1.2-3-6.7H16z"
							stroke="#fff"
							strokeLinejoin="round"
							strokeWidth={1.5}
							style={{ fill: color }}
						/>
					</svg>
					{pointer.label && anchor ? (
						<NameTag
							botName={botName}
							className={cn(
								anchor.horizontal === "right" ? "left-4" : "right-2",
								anchor.vertical === "below" ? "top-5" : "bottom-5",
							)}
							color={color}
							label={pointer.label}
						/>
					) : null}
				</div>
			) : null}
			{pointer.label && !position ? (
				<NameTag
					botName={botName}
					className="bottom-2 left-1/2 max-w-[90%] -translate-x-1/2"
					color={color}
					label={pointer.label}
				/>
			) : null}
		</div>
	);
}

/**
 * Cobre a imagem/stream do sandbox (o pai precisa ser `relative`). Mede o
 * container, escala o ponto considerando o letterbox e some após alguns
 * segundos sem ação do agente.
 */
export function AgentPointerOverlay({
	pointer,
	botName,
	color,
	idleMs = AGENT_POINTER_IDLE_MS,
}: {
	pointer: AgentPointerState | null;
	/** Nome do bot mostrado na etiqueta. */
	botName?: string;
	/** Cor do bot (hex). */
	color?: string;
	idleMs?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
	const [hiddenSeq, setHiddenSeq] = useState(-1);
	const seq = pointer?.seq ?? -1;

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const { width, height } = element.getBoundingClientRect();
			setContainer((prev) =>
				prev.width === width && prev.height === height ? prev : { width, height },
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (seq < 0) return;
		return scheduleIdleFade(() => setHiddenSeq(seq), idleMs);
	}, [seq, idleMs]);

	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0"
			ref={ref}
		>
			{pointer ? (
				<AgentPointerLayer
					botName={botName}
					color={color}
					container={container}
					pointer={pointer}
					visible={hiddenSeq !== seq}
				/>
			) : null}
		</div>
	);
}
