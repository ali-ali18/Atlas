"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { COMPOSIO_PAGE_SIZE_DEFAULT } from "@workspace/shared";
import { composioHasPrev, composioPageLabel, type ComposioPager } from "./composio-state";

/** Anterior / "Página N de M" / Próxima do catálogo do Composio (Configurações e Marketplace). */
export function ComposioPagerBar({
	pager,
	hasNext,
	totalItems,
	disabled,
	onPrev,
	onNext,
}: {
	pager: ComposioPager;
	hasNext: boolean;
	totalItems: number | null;
	disabled?: boolean;
	onPrev: () => void;
	onNext: () => void;
}) {
	const hasPrev = composioHasPrev(pager);
	if (!hasPrev && !hasNext) return null;
	return (
		<nav aria-label="Paginação do catálogo do Composio" className="flex items-center justify-between gap-3 pt-2">
			<Button disabled={disabled || !hasPrev} onClick={onPrev} size="sm" type="button" variant="outline">
				<ChevronLeftIcon aria-hidden />
				Anterior
			</Button>
			<span aria-live="polite" className="text-xs text-muted-foreground">
				{composioPageLabel(pager, totalItems, COMPOSIO_PAGE_SIZE_DEFAULT)}
			</span>
			<Button disabled={disabled || !hasNext} onClick={onNext} size="sm" type="button" variant="outline">
				Próxima
				<ChevronRightIcon aria-hidden />
			</Button>
		</nav>
	);
}
