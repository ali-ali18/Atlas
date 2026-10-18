"use client";

import { CheckIcon, ChevronDownIcon, EllipsisVerticalIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@workspace/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@workspace/ui/components/dropdown-menu";
import { approvalBarLabel, APPROVAL_STACK_PEEKS, dockEntryPrefixes, type DockEntry } from "@/lib/approval-dock";
import { devApprovalOptions } from "@/lib/dev-approval-options";

export type ApprovalBarProps = {
	/** Pedidos pendentes que já saíram da tela, do mais antigo ao mais recente (os visíveis ficam só no cartão da conversa). */
	entries: DockEntry[];
	onApprove: (entry: DockEntry) => void;
	onSkip: (entry: DockEntry) => void;
	/** "Sempre neste repositório": salva os prefixos do comando na lista do repositório e executa. Sem ela a barra não oferece o menu ⋮. */
	onAlways?: (entry: DockEntry) => void;
	/** Rola até o cartão na conversa e o destaca. */
	onLocate: (id: string) => void;
	/** Altura da barra (px), para a conversa deixar espaço embaixo. */
	onHeight?: (height: number) => void;
	/** Começa com a lista aberta (testes). */
	defaultExpanded?: boolean;
};

const PEEK_PX = 7;
const PEEK_INSET_PX = 10;

type RowProps = Pick<ApprovalBarProps, "onApprove" | "onSkip" | "onLocate" | "onAlways"> & { entry: DockEntry; extra?: ReactNode };

function Row({ entry, onApprove, onSkip, onLocate, onAlways, extra }: RowProps) {
	const prefixes = dockEntryPrefixes(entry);
	const options = devApprovalOptions({ prefixes, canAlways: Boolean(onAlways) });
	return (
		<div className="flex min-h-11 min-w-0 items-center gap-1 pr-1 pl-3" data-approval-bar-row>
			<ShieldAlertIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<button
				className="min-w-0 flex-1 truncate rounded-md px-1.5 py-2 text-left text-foreground/90 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
				onClick={() => onLocate(entry.id)}
				type="button"
			>
				{approvalBarLabel(entry)}
			</button>
			{extra}
			{options.length > 1 ? (
				<DropdownMenu>
					<DropdownMenuTrigger render={<Button aria-label="Mais opções" className="size-9 shrink-0 rounded-full" data-approval-bar-more size="icon-sm" type="button" variant="ghost" />}>
						<EllipsisVerticalIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-auto max-w-[20rem] min-w-44" side="top">
						{options.map((option) => (
							<DropdownMenuItem className="min-w-0" key={option.id} onClick={() => (option.id === "once" ? onApprove(entry) : option.id === "always" ? onAlways?.(entry) : onSkip(entry))} title={option.detail}>
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{option.label}</span>
									{option.detail ? <span className="truncate text-muted-foreground text-xs">{option.detail}</span> : null}
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
			<Button aria-label="Executar" className="size-9 shrink-0 rounded-full" onClick={() => onApprove(entry)} size="icon-sm" type="button" variant="ghost">
				<CheckIcon />
			</Button>
			<Button aria-label="Pular" className="size-9 shrink-0 rounded-full" onClick={() => onSkip(entry)} size="icon-sm" type="button" variant="ghost">
				<XIcon />
			</Button>
		</div>
	);
}

/**
 * Faixa colada ao topo do campo de texto (sai de trás dele), só com pedidos de aprovação que a conversa já deixou
 * para trás. Um pedido: uma linha (alerta + "Executar · comando", ✓ e ✗). Dois ou mais: pilha, como notificações; o
 * mais recente na frente e os outros espiando por trás, com o contador "+N". Tocar a pilha abre a lista inteira.
 */
export function ApprovalBar({ entries: live, onApprove, onSkip, onLocate, onAlways, onHeight, defaultExpanded = false }: ApprovalBarProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [shown, setShown] = useState(false);
	const [kept, setKept] = useState<DockEntry[]>(live);
	const rootRef = useRef<HTMLDivElement>(null);
	// Sai deslizando para trás do composer: guarda as últimas linhas até a transição acabar.
	const entries = live.length > 0 ? live : kept;
	const present = entries.length > 0;
	const liveKey = live.map((entry) => entry.id).join("|");
	const liveRef = useRef(live);
	liveRef.current = live;
	useEffect(() => {
		if (liveRef.current.length > 0) {
			setKept(liveRef.current);
			const frame = requestAnimationFrame(() => setShown(true));
			return () => cancelAnimationFrame(frame);
		}
		setShown(false);
		const timer = window.setTimeout(() => setKept([]), 220);
		return () => window.clearTimeout(timer);
	}, [liveKey]);

	// Volta a 1 item: recolhe sozinha.
	useEffect(() => {
		if (entries.length < 2) setExpanded(false);
	}, [entries.length]);

	// Toque fora recolhe.
	useEffect(() => {
		if (!expanded) return;
		const onPointerDown = (event: PointerEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setExpanded(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [expanded]);

	useEffect(() => {
		const element = rootRef.current;
		if (!present || !element || !onHeight || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
		observer.observe(element);
		onHeight(element.offsetHeight);
		return () => {
			observer.disconnect();
			onHeight(0);
		};
	}, [onHeight, present]);

	if (!present) return null;
	const front = entries[entries.length - 1]!;
	const behind = entries.slice(0, -1);
	const peeks = Math.min(behind.length, APPROVAL_STACK_PEEKS);
	const stacked = behind.length > 0;
	const handlers = { onApprove, onSkip, onLocate, onAlways };
	const toggle = () => setExpanded((current) => !current);

	return (
		<div
			aria-label="Aprovações pendentes"
			className={`relative z-0 mx-auto -mb-5 w-[calc(100%-1.5rem)] min-w-0 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none ${shown && live.length > 0 ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`}
			data-approval-bar
			data-expanded={expanded || undefined}
			data-stacked={stacked || undefined}
			ref={rootRef}
			role="region"
		>
			{stacked ? (
				<div
					aria-hidden="true"
					className="relative transition-[height] duration-200 ease-out motion-reduce:transition-none"
					data-approval-stack-peeks
					style={{ height: expanded ? 0 : peeks * PEEK_PX }}
				>
					{Array.from({ length: peeks }, (_, index) => {
						const level = index + 1;
						return (
							<button
								className="absolute h-6 rounded-t-3xl border-t border-foreground/15 bg-muted outline-none transition-opacity duration-200 motion-reduce:transition-none"
								data-approval-stack-layer={level}
								key={level}
								onClick={toggle}
								style={{ left: level * PEEK_INSET_PX, right: level * PEEK_INSET_PX, top: (peeks - level) * PEEK_PX, opacity: expanded ? 0 : 1 - level * 0.2 }}
								tabIndex={-1}
								type="button"
							/>
						);
					})}
				</div>
			) : null}
			{stacked ? (
				<div
					className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
					data-approval-bar-list
					style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
				>
					<div className="min-h-0 overflow-hidden rounded-t-3xl bg-muted">
						<div className="flex items-center justify-between px-3 pt-2 text-muted-foreground text-xs">
							<span>{entries.length} aprovações pendentes</span>
							<Button aria-label="Recolher" className="size-7 rounded-full" onClick={toggle} size="icon-xs" type="button" variant="ghost">
								<ChevronDownIcon />
							</Button>
						</div>
						<div className="flex flex-col divide-y divide-foreground/10">
							{behind.map((entry) => (
								<Row entry={entry} key={entry.id} {...handlers} />
							))}
						</div>
					</div>
				</div>
			) : null}
			<div
				className={`relative z-10 border-t border-foreground/15 bg-muted pb-5 ${stacked && expanded ? "" : "rounded-t-3xl"}`}
				data-approval-bar-front
			>
				<Row
					entry={front}
					extra={
						stacked && !expanded ? (
							<button
								aria-expanded={expanded}
								aria-label={`Mais ${behind.length} ${behind.length === 1 ? "aprovação" : "aprovações"}`}
								className="shrink-0 rounded-full bg-foreground/10 px-2 py-1 text-foreground/80 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
								data-approval-stack-count
								onClick={toggle}
								type="button"
							>
								+{behind.length}
							</button>
						) : null
					}
					{...handlers}
				/>
			</div>
		</div>
	);
}
