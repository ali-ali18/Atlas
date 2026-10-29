"use client";

import { ArrowDownIcon } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

import { useTranslations } from "@/lib/i18n/provider";
import { defaultTranslator } from "@/lib/i18n/translator";
import { JUMP_ARROW_PX } from "@/lib/follow-bottom";
import { needsBottomCorrection } from "@/lib/scroll-bottom";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

/** Rótulo da pílula: "↓ 3 novas" (singular: "↓ 1 nova"). */
export function newCountLabel(count: number, { tn } = defaultTranslator): string {
	return tn("chat.newCount", count);
}

export function ScrollToBottom({
	targetRef,
	newCount = 0,
	onJump,
}: {
	targetRef: RefObject<HTMLElement | null>;
	/** Mensagens novas fora da tela; > 0 mostra a pílula "↓ N novas". */
	newCount?: number;
	/** Tocou na seta: volta a acompanhar o fim. */
	onJump?: () => void;
}) {
	const translator = useTranslations();
	const { t } = translator;
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		const element = targetRef.current;
		if (!element) return;

		const update = () => {
			const distance =
				element.scrollHeight - element.scrollTop - element.clientHeight;
			setVisible(distance > JUMP_ARROW_PX);
		};

		update();
		element.addEventListener("scroll", update, { passive: true });
		return () => element.removeEventListener("scroll", update);
	}, [targetRef]);

	const pill = newCount > 0;
	return (
		<Button
			aria-label={pill ? t("chat.scrollToEndWithNew", { label: newCountLabel(newCount, translator) }) : t("chat.scrollToEnd")}
			className={cn(
				"absolute bottom-40 left-1/2 -translate-x-1/2 rounded-full shadow-md transition-all duration-200 dark:bg-background",
				visible ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0",
			)}
			data-testid="scroll-to-bottom"
			onClick={() => {
				const element = targetRef.current;
				if (!element) return;
				onJump?.();
				element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
				// O layout pode mudar no meio da rolagem suave (barra de aprovação, imagens): confere no fim e corrige.
				window.setTimeout(() => {
					if (needsBottomCorrection(element)) element.scrollTo({ top: element.scrollHeight });
				}, 600);
			}}
			size={pill ? "lg" : "icon-lg"}
			variant="outline"
		>
			<ArrowDownIcon />
			{pill ? <span className="text-sm">{newCountLabel(newCount, translator)}</span> : null}
		</Button>
	);
}
