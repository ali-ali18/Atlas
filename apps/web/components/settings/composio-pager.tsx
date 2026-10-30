"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { COMPOSIO_PAGE_SIZE_DEFAULT } from "@workspace/shared";
import { useTranslations } from "@/lib/i18n/provider";
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
	const translator = useTranslations();
	const { t } = translator;
	const hasPrev = composioHasPrev(pager);
	if (!hasPrev && !hasNext) return null;
	return (
		<nav aria-label={t("settings.composio.pagerAria")} className="flex items-center justify-between gap-3 pt-2">
			<Button disabled={disabled || !hasPrev} onClick={onPrev} size="sm" type="button" variant="outline">
				<ChevronLeftIcon aria-hidden />
				{t("settings.composio.prev")}
			</Button>
			<span aria-live="polite" className="text-xs text-muted-foreground">
				{composioPageLabel(pager, totalItems, COMPOSIO_PAGE_SIZE_DEFAULT, translator)}
			</span>
			<Button disabled={disabled || !hasNext} onClick={onNext} size="sm" type="button" variant="outline">
				{t("settings.composio.next")}
				<ChevronRightIcon aria-hidden />
			</Button>
		</nav>
	);
}
