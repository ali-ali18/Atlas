import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";
export type JevToolReview = {
	mode: "shadow" | "gate";
	result: "allow" | "ask" | "unavailable";
};

export function isJevToolReview(value: unknown): value is JevToolReview {
	if (!value || typeof value !== "object") return false;
	const review = value as Record<string, unknown>;
	return (review.mode === "shadow" || review.mode === "gate") &&
		(review.result === "allow" || review.result === "ask" || review.result === "unavailable");
}

/** Texto seguro para o chat: só descreve decisão e resultado da execução. */
export function jevStatusText(review: JevToolReview, toolOk: boolean, { t }: Translator = getActiveTranslator()): string {
	if (review.mode === "gate") {
		if (review.result === "ask") return t("status.jev.gateAsk");
		if (review.result === "unavailable") return t("status.jev.gateUnavailable");
		return toolOk
			? t("status.jev.gateApproved")
			: t("status.jev.gateToolFailed");
	}
	if (review.result === "unavailable") {
		return toolOk
			? t("status.jev.shadowUnavailableOk")
			: t("status.jev.shadowUnavailableFailed");
	}
	if (review.result === "ask") {
		return toolOk
			? t("status.jev.shadowAskOk")
			: t("status.jev.shadowAskFailed");
	}
	return toolOk
		? t("status.jev.shadowObservedOk")
		: t("status.jev.shadowObservedFailed");
}
