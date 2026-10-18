import { alwaysAllowDetail, alwaysAllowLabel } from "@workspace/shared";

export type DevApprovalOption = { id: "once" | "always" | "skip"; label: string; detail?: string };

/**
 * Opções do menu ⋮ de um pedido de comando: "Permitir uma vez" (o mesmo que o botão primário),
 * "Sempre neste repositório" (só com prefixos para liberar e quem trate a ação) e "Pular".
 * Sem prefixos o menu fica só com o Pular, como antes.
 */
export function devApprovalOptions(input: { prefixes?: readonly string[]; canAlways: boolean; cancelLabel?: string }): DevApprovalOption[] {
	const prefixes = input.prefixes ?? [];
	const skip: DevApprovalOption = { id: "skip", label: input.cancelLabel ?? "Pular" };
	if (!input.canAlways || prefixes.length === 0) return [skip];
	return [{ id: "once", label: "Permitir uma vez" }, { id: "always", label: alwaysAllowLabel(prefixes), detail: alwaysAllowDetail(prefixes) }, skip];
}
