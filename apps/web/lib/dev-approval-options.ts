import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";
import { alwaysAllowDetail, alwaysAllowLabel } from "@/lib/shared-labels";

export type DevApprovalOption = { id: "once" | "always" | "skip"; label: string; detail?: string };

/**
 * Opções do menu ⋮ de um pedido de comando: "Permitir uma vez" (o mesmo que o botão primário),
 * "Sempre neste repositório" (só com prefixos para liberar e quem trate a ação) e "Agora não".
 * Sem prefixos o menu fica só com o "Agora não", como antes.
 */
export function devApprovalOptions(input: { prefixes?: readonly string[]; canAlways: boolean; cancelLabel?: string }, translator: Translator = getActiveTranslator()): DevApprovalOption[] {
	const { t } = translator;
	const prefixes = input.prefixes ?? [];
	const skip: DevApprovalOption = { id: "skip", label: input.cancelLabel ?? t("status.proposal.notNow") };
	if (!input.canAlways || prefixes.length === 0) return [skip];
	return [{ id: "once", label: t("status.devApproval.allowOnce") }, { id: "always", label: alwaysAllowLabel(prefixes, translator), detail: alwaysAllowDetail(prefixes, translator) }, skip];
}
