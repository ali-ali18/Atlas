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
export function jevStatusText(review: JevToolReview, toolOk: boolean): string {
	if (review.mode === "gate") {
		if (review.result === "ask") return "JEV pediu confirmação; a ação ainda não foi executada.";
		if (review.result === "unavailable") return "JEV indisponível; a ação aguarda confirmação.";
		return toolOk
			? "JEV aprovou esta ação."
			: "JEV permitiu a ação, mas a ferramenta falhou.";
	}
	if (review.result === "unavailable") {
		return toolOk
			? "JEV indisponível no modo de observação; a ação foi executada."
			: "JEV indisponível no modo de observação; a ferramenta falhou.";
	}
	if (review.result === "ask") {
		return toolOk
			? "JEV recomendaria confirmação no modo de observação; a ação foi executada."
			: "JEV recomendaria confirmação no modo de observação; a ferramenta falhou.";
	}
	return toolOk
		? "JEV observou esta ação; ela foi executada."
		: "JEV observou esta ação; a ferramenta falhou.";
}
