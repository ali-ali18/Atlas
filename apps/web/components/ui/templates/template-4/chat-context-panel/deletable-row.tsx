"use client";

import { Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@workspace/ui/components/button";
import { ConfirmAlert } from "@workspace/ui/components/confirm-alert";
import { cn } from "@workspace/ui/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";

/**
 * Linha de lista com apagar escondido: no mouse a lixeira aparece no hover ou foco; no toque, só depois de pressão
 * longa. Apagar pede confirmação na própria linha (`ConfirmAlert` destrutivo), que troca de lugar com o conteúdo.
 * Um só padrão para o Caderno (notas, regras) e a Agenda (cancelar combinado).
 */
export function DeletableRow({
	rowId,
	deleteLabel,
	confirmTitle,
	confirmBody,
	confirmLabel,
	cancelLabel,
	busy = false,
	canDelete = true,
	trailing,
	rowData,
	revealed: initialRevealed = false,
	confirming: initialConfirming = false,
	onDelete,
	children,
}: {
	rowId: string;
	deleteLabel: string;
	confirmTitle: string;
	confirmBody: string;
	confirmLabel: string;
	cancelLabel: string;
	busy?: boolean;
	/** `false` esconde a lixeira (ex.: combinado já encerrado). */
	canDelete?: boolean;
	/** Controle fixo à direita da lixeira (ex.: o interruptor de pausar da Agenda). */
	trailing?: ReactNode;
	/** Atributos `data-*` extras na linha (ganchos de teste e prévia). */
	rowData?: Record<`data-${string}`, string | undefined>;
	/** Estados de saída (teste e prévia); no uso real nascem da pressão longa e do clique. */
	revealed?: boolean;
	confirming?: boolean;
	onDelete: () => void;
	children: ReactNode;
}) {
	const [revealed, setRevealed] = useState(initialRevealed);
	const [confirming, setConfirming] = useState(initialConfirming);
	const rowRef = useRef<HTMLLIElement>(null);
	const trashRef = useRef<HTMLButtonElement>(null);
	// Ao desistir da confirmação o foco volta à lixeira (teclado e leitor de tela não caem no topo da página).
	const returnFocus = useRef(false);
	useEffect(() => {
		if (confirming || !returnFocus.current) return;
		returnFocus.current = false;
		trashRef.current?.focus();
	}, [confirming]);
	const longPress = useLongPress(() => setRevealed(true));

	useEffect(() => {
		if (!revealed) return;
		// Tocar fora da linha esconde a lixeira de novo.
		const onPointerDown = (event: PointerEvent) => {
			if (!rowRef.current?.contains(event.target as Node)) setRevealed(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [revealed]);

	if (confirming) {
		return (
			<li className="min-w-0" data-deletable-row={rowId} {...rowData}>
				<ConfirmAlert
					cancelLabel={cancelLabel}
					confirmLabel={confirmLabel}
					description={confirmBody}
					destructive
					selfConfirm
					disabled={busy}
					onCancel={() => {
						returnFocus.current = true;
						setConfirming(false);
					}}
					onConfirm={() => {
						setConfirming(false);
						setRevealed(false);
						onDelete();
					}}
					title={confirmTitle}
				/>
			</li>
		);
	}
	return (
		<li
			className="group/row relative flex min-w-0 items-stretch gap-1 rounded-card border border-border/60 bg-card transition-colors [@media(hover:hover)]:hover:bg-muted/40 [@media(hover:none)]:select-none"
			data-deletable-row={rowId}
			{...rowData}
			ref={rowRef}
			{...longPress}
		>
			<div className="min-w-0 flex-1">{children}</div>
			{canDelete ? (
				<Button
					aria-label={deleteLabel}
					ref={trashRef}
					className={cn(
						"my-1 mr-1 shrink-0 self-start transition-opacity",
						"[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100 focus-visible:opacity-100",
						// No toque fica fora da vista até a pressão longa, mas continua na árvore de acessibilidade (leitor de tela alcança).
						!revealed && "[@media(hover:none)]:sr-only",
					)}
					disabled={busy}
					onClick={() => setConfirming(true)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					<Trash2Icon aria-hidden />
				</Button>
			) : null}
			{trailing ? <div className="shrink-0 self-start pt-3 pr-3">{trailing}</div> : null}
		</li>
	);
}
