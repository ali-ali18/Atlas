import type { DevApprovalMode } from "@workspace/shared";

import type { TFunction } from "@/lib/i18n/translator";

/** Nome e ajuda de cada modo de permissão do código, no idioma da tela (os textos de `shared` ficam em pt-BR). */
export function permissionLabel(t: TFunction, mode: DevApprovalMode): string {
	if (mode === "ask") return t("composer.permission.ask.label");
	if (mode === "allowlist") return t("composer.permission.allowlist.label");
	return t("composer.permission.auto.label");
}

export function permissionHelp(t: TFunction, mode: DevApprovalMode): string {
	if (mode === "ask") return t("composer.permission.ask.help");
	if (mode === "allowlist") return t("composer.permission.allowlist.help");
	return t("composer.permission.auto.help");
}

/** Linha do seletor: o modo recomendado (automático) leva a marca. */
export function permissionOptionLabel(t: TFunction, mode: DevApprovalMode): string {
	const label = permissionLabel(t, mode);
	return mode === "auto" ? t("composer.recommended", { label }) : label;
}
