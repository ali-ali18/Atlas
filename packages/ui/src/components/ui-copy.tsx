"use client";

import * as React from "react";

import { CHAT_CARD_COPY } from "../lib/chat-card-copy";

/**
 * Textos fixos dos componentes de `packages/ui` (cards de aprovação e plano, copiar código, gráfico).
 * O pacote não conhece o app: o padrão é pt-BR e o app injeta o idioma da tela com `UiCopyProvider`.
 * Texto passado por prop (ex.: `confirmLabel`) continua mandando sobre o padrão daqui.
 */
export type UiCopy = {
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
};

export const DEFAULT_UI_COPY: UiCopy = {
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
};

const UiCopyContext = React.createContext<UiCopy>(DEFAULT_UI_COPY);

function UiCopyProvider({ copy, children }: { copy: Partial<UiCopy>; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ ...DEFAULT_UI_COPY, ...copy }), [copy]);
  return <UiCopyContext.Provider value={value}>{children}</UiCopyContext.Provider>;
}

function useUiCopy(): UiCopy {
  return React.useContext(UiCopyContext);
}

export { UiCopyProvider, useUiCopy };

/** "Ver tudo (3)": rótulo fechado de uma lista recolhida, no idioma do `UiCopy`. */
export function seeAllText(copy: UiCopy, count: number): string {
  return copy.cardSeeAllCount.replace("{count}", String(count));
}
