"use client";

import * as React from "react";

import { ChartLocaleContext } from "../charts/chart-formatters";
import { CHAT_CARD_COPY } from "../lib/chat-card-copy";

/**
 * Textos fixos dos componentes de `packages/ui` (cards de aprovação e plano, copiar código, gráfico).
 * O pacote não conhece o app: o padrão é pt-BR e o app injeta o idioma da tela com `UiCopyProvider`.
 * Texto passado por prop (ex.: `confirmLabel`) continua mandando sobre o padrão daqui.
 */
export type UiCopy = {
  /**
   * Idioma da tela (BCP 47, ex.: "en-US"). Gráficos e avatar formatam número, data e maiúscula com ele;
   * `UiCopyProvider` o entrega aos gráficos por contexto. Padrão: pt-BR.
   */
  locale: string;
  codeCopy: string;
  /** Vocabulário comum dos cards (ver `lib/chat-card-copy.ts`). */
  cardDetails: string;
  cardLess: string;
  cardSeeAll: string;
  /** "Ver tudo ({count})". */
  cardSeeAllCount: string;
  cardDismiss: string;
  cardDismissed: string;
  cardNeedsYou: string;
  cardDeny: string;
  codeCopied: string;
  chartCopyCsv: string;
  confirmApproved: string;
  confirmRejected: string;
  confirmNotApproved: string;
  confirmFailed: string;
  confirmAttention: string;
  confirm: string;
  cancel: string;
  edit: string;
  confirmAlways: string;
  planApproved: string;
  planAdjusted: string;
  planCancelled: string;
  planFailed: string;
  planApprove: string;
  planAdjust: string;
  planViewPlan: string;
  planNote: string;
  planNeeds: string;
  planRisk: string;
  planKindRead: string;
  planKindWrite: string;
  planKindAsk: string;
  planKindOther: string;
  /** Legenda da meta do gráfico: "a partir de {value}" / "até {value}". */
  chartFrom: string;
  chartUpTo: string;
  /** Selos de capacidade do modelo (texto e dica). */
  capVision: string;
  capVisionTitle: string;
  capPdfTitle: string;
  capTools: string;
  capToolsTitle: string;
  capContextTitle: string;
};

export const DEFAULT_UI_COPY: UiCopy = {
  locale: "pt-BR",
  codeCopy: "Copiar código",
  cardDetails: CHAT_CARD_COPY.details,
  cardLess: CHAT_CARD_COPY.less,
  cardSeeAll: CHAT_CARD_COPY.seeAll,
  cardSeeAllCount: "Ver tudo ({count})",
  cardDismiss: CHAT_CARD_COPY.dismiss,
  cardDismissed: CHAT_CARD_COPY.dismissed,
  cardNeedsYou: CHAT_CARD_COPY.needsYou,
  cardDeny: CHAT_CARD_COPY.deny,
  codeCopied: "Código copiado",
  chartCopyCsv: "Copiar dados (CSV)",
  confirmApproved: "Aprovado",
  confirmRejected: "Recusado",
  confirmNotApproved: "Não aprovado",
  confirmFailed: "Falhou",
  confirmAttention: "Atenção",
  confirm: "Confirmar",
  cancel: "Cancelar",
  edit: "Editar",
  confirmAlways: "Não perguntar mais para isto",
  planApproved: "Plano aprovado",
  planAdjusted: "Ajuste pedido",
  planCancelled: "Cancelado",
  planFailed: "Falhou",
  planApprove: "Aprovar plano",
  planAdjust: "Ajustar",
  planViewPlan: "Ver plano",
  planNote: "Aprovar o plano não aprova as ações: cada alteração ainda pede sua confirmação.",
  planNeeds: "Preciso de",
  planRisk: "Atenção:",
  planKindRead: "Leitura",
  planKindWrite: "Altera dados",
  planKindAsk: "Pergunta",
  planKindOther: "Passo",
  chartFrom: "a partir de {value}",
  chartUpTo: "até {value}",
  capVision: "Imagem",
  capVisionTitle: "Lê imagens",
  capPdfTitle: "Lê PDF nativamente",
  capTools: "Ferramentas",
  capToolsTitle: "Usa ferramentas",
  capContextTitle: "Janela de contexto",
};

const UiCopyContext = React.createContext<UiCopy>(DEFAULT_UI_COPY);

function UiCopyProvider({ copy, children }: { copy: Partial<UiCopy>; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ ...DEFAULT_UI_COPY, ...copy }), [copy]);
  // O idioma dos gráficos viaja por contexto (não por variável global): ver `charts/chart-formatters.ts`.
  return (
    <UiCopyContext.Provider value={value}>
      <ChartLocaleContext.Provider value={value.locale}>{children}</ChartLocaleContext.Provider>
    </UiCopyContext.Provider>
  );
}

function useUiCopy(): UiCopy {
  return React.useContext(UiCopyContext);
}

export { UiCopyProvider, useUiCopy };

/** "Ver tudo (3)": rótulo fechado de uma lista recolhida, no idioma do `UiCopy`. */
export function seeAllText(copy: UiCopy, count: number): string {
  return copy.cardSeeAllCount.replace("{count}", String(count));
}
