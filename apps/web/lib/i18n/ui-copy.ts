import type { UiCopy } from "@workspace/ui/components/ui-copy";
import { DEFAULT_UI_LOCALE } from "./locales";
import type { TFunction } from "./translator";

/** Textos dos componentes de packages/ui no idioma da tela (o pacote não conhece o dicionário do app). */
export function uiCopyFrom(t: TFunction, locale: string = DEFAULT_UI_LOCALE): UiCopy {
	return {
		locale,
		codeCopy: t("ui.codeCopy"),
		codeCopied: t("ui.codeCopied"),
		cardDetails: t("ui.cardDetails"),
		cardLess: t("ui.cardLess"),
		cardSeeAll: t("ui.cardSeeAll"),
		// O pacote preenche o {count} na hora de desenhar: aqui o marcador passa intacto.
		cardSeeAllCount: t("ui.cardSeeAllCount", { count: "{count}" }),
		cardDismiss: t("ui.cardDismiss"),
		cardDismissed: t("ui.cardDismissed"),
		cardNeedsYou: t("ui.cardNeedsYou"),
		cardDeny: t("ui.cardDeny"),
		chartCopyCsv: t("ui.chartCopyCsv"),
		confirmApproved: t("ui.confirmApproved"),
		confirmRejected: t("ui.confirmRejected"),
		confirmNotApproved: t("ui.confirmNotApproved"),
		confirmFailed: t("ui.confirmFailed"),
		confirmAttention: t("ui.confirmAttention"),
		confirm: t("ui.confirm"),
		cancel: t("ui.cancel"),
		edit: t("ui.edit"),
		confirmAlways: t("ui.confirmAlways"),
		planApproved: t("ui.planApproved"),
		planAdjusted: t("ui.planAdjusted"),
		planCancelled: t("ui.planCancelled"),
		planFailed: t("ui.planFailed"),
		planApprove: t("ui.planApprove"),
		planAdjust: t("ui.planAdjust"),
		planViewPlan: t("ui.planViewPlan"),
		planNote: t("ui.planNote"),
		planNeeds: t("ui.planNeeds"),
		planRisk: t("ui.planRisk"),
		planKindRead: t("ui.planKindRead"),
		planKindWrite: t("ui.planKindWrite"),
		planKindAsk: t("ui.planKindAsk"),
		planKindOther: t("ui.planKindOther"),
		chartFrom: t("ui.chartFrom", { value: "{value}" }),
		chartUpTo: t("ui.chartUpTo", { value: "{value}" }),
		capVision: t("ui.capVision"),
		capVisionTitle: t("ui.capVisionTitle"),
		capPdfTitle: t("ui.capPdfTitle"),
		capTools: t("ui.capTools"),
		capToolsTitle: t("ui.capToolsTitle"),
		capContextTitle: t("ui.capContextTitle"),
	};
}
