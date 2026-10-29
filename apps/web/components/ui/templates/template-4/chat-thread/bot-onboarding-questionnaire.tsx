"use client";

import * as React from "react";

import { useT } from "@/lib/i18n/provider";

import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@workspace/ui/components/questionnaire";

/**
 * Items espelhados em `Root.items` (atalhos de teclado + progresso +
 * validação) e nos `QuestionnaireItem` renderizados. Manter os dois
 * sincronizados — o primitive avisa no console (`[Questionnaire] …`)
 * quando divergem.
 */
const ONBOARDING_ITEMS = [
  {
    name: "direction",
    required: true,
    choices: [
      { value: "delegation" },
      { value: "questions" },
      { value: "both" },
    ],
  },
  {
    name: "detail",
    required: true,
    choices: [{ value: "focused" }, { value: "complete" }],
  },
  { name: "purpose", required: false },
] as const;

export type BotOnboardingPayload = {
  /** getAll("direction"): choice(s) radio + texto livre (mesmo name). */
  direction: string[];
  /** get("detail"): "focused" | "complete". */
  detail: string | null;
  /** get("purpose"): texto livre opcional (pode ser null se pulado). */
  purpose: string | null;
  /** Snapshot cru do FormData para debug. */
  raw: Record<string, string | string[]>;
};

/**
 * Monta o payload estruturado a partir do FormData do submit.
 * Próximo passo (backend): POST deste objeto ao criar/atualizar o bot.
 */
export function buildBotOnboardingPayload(
  formData: FormData,
): BotOnboardingPayload {
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    const values = formData.getAll(key).map(String);
    raw[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  return {
    direction: formData.getAll("direction").map(String),
    detail: formData.get("detail")?.toString() ?? null,
    purpose: formData.get("purpose")?.toString() || null,
    raw,
  };
}

export function BotOnboardingQuestionnaire({
  onSubmitPayload,
}: {
  /** Hook opcional para o próximo passo (envio ao backend). */
  onSubmitPayload?: (payload: BotOnboardingPayload) => void;
}) {
  const t = useT();
  const [payload, setPayload] = React.useState<BotOnboardingPayload | null>(
    null,
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // O primitive valida o item atual antes de chegar aqui; o
    // preventDefault evita navegação e deixa o FormData disponível.
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const next = buildBotOnboardingPayload(formData);
    // Por enquanto: só loga + exibe estado. Sem chamada de backend.
    // eslint-disable-next-line no-console
    console.log("[bot-onboarding] FormData payload", next);
    setPayload(next);
    onSubmitPayload?.(next);
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Questionnaire
        items={[...ONBOARDING_ITEMS]}
        onSubmit={handleSubmit}
        shortcuts="letters"
      >
        <QuestionnaireProgress />

        <QuestionnaireItem name="direction" required>
          <QuestionnaireTitle>
            {t("chatExtras.onboarding.directionTitle")}
          </QuestionnaireTitle>
          <QuestionnaireDescription>
            {t("chatExtras.onboarding.directionHelp")}
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice value="delegation">
              {t("chatExtras.onboarding.delegate")}
              <QuestionnaireChoiceDescription>
                {t("chatExtras.onboarding.delegateHelp")}
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="questions">
              {t("chatExtras.onboarding.answer")}
              <QuestionnaireChoiceDescription>
                {t("chatExtras.onboarding.answerHelp")}
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="both">
              {t("chatExtras.onboarding.both")}
              <QuestionnaireChoiceDescription>
                {t("chatExtras.onboarding.bothHelp")}
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <QuestionnaireInput placeholder={t("chatExtras.onboarding.ownWay")} />
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>{t("chatExtras.onboarding.back")}</QuestionnairePrevious>
            <QuestionnaireSkip>{t("chatExtras.onboarding.skip")}</QuestionnaireSkip>
            <QuestionnaireNext>{t("chatExtras.onboarding.next")}</QuestionnaireNext>
            <QuestionnaireSubmit>{t("chatExtras.onboarding.done")}</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>

        <QuestionnaireItem name="detail" required>
          <QuestionnaireTitle>{t("chatExtras.onboarding.detailTitle")}</QuestionnaireTitle>
          <QuestionnaireDescription>
            {t("chatExtras.onboarding.detailHelp")}
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice value="focused">
              {t("chatExtras.onboarding.focused")}
              <QuestionnaireChoiceDescription>
                {t("chatExtras.onboarding.focusedHelp")}
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="complete">
              {t("chatExtras.onboarding.complete")}
              <QuestionnaireChoiceDescription>
                {t("chatExtras.onboarding.completeHelp")}
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>{t("chatExtras.onboarding.back")}</QuestionnairePrevious>
            <QuestionnaireSkip>{t("chatExtras.onboarding.skip")}</QuestionnaireSkip>
            <QuestionnaireNext>{t("chatExtras.onboarding.next")}</QuestionnaireNext>
            <QuestionnaireSubmit>{t("chatExtras.onboarding.done")}</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>

        <QuestionnaireItem name="purpose" required={false}>
          <QuestionnaireTitle>{t("chatExtras.onboarding.purposeTitle")}</QuestionnaireTitle>
          <QuestionnaireDescription>
            {t("chatExtras.onboarding.purposeHelp")}
          </QuestionnaireDescription>
          <QuestionnaireInput placeholder={t("chatExtras.onboarding.purposePlaceholder")} />
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>{t("chatExtras.onboarding.back")}</QuestionnairePrevious>
            <QuestionnaireSkip>{t("chatExtras.onboarding.skip")}</QuestionnaireSkip>
            <QuestionnaireNext>{t("chatExtras.onboarding.next")}</QuestionnaireNext>
            <QuestionnaireSubmit>{t("chatExtras.onboarding.done")}</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>
      </Questionnaire>

      {payload ? (
        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="text-xs font-medium text-muted-foreground">
            {t("chatExtras.onboarding.payload")}
          </p>
          <pre className="mt-2 overflow-x-auto text-xs leading-relaxed">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
