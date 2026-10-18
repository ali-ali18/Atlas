"use client";

import * as React from "react";

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
            Como esse bot deve trabalhar?
          </QuestionnaireTitle>
          <QuestionnaireDescription>
            Escolha um modo ou escreva do seu jeito no campo livre.
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice value="delegation">
              Delegar tarefas
              <QuestionnaireChoiceDescription>
                Executa rotinas e ações por você
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="questions">
              Responder perguntas
              <QuestionnaireChoiceDescription>
                Tira dúvidas com base no que sabe
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="both">
              Os dois
              <QuestionnaireChoiceDescription>
                Alterna entre executar e responder
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <QuestionnaireInput placeholder="Ou descreva do seu jeito…" />
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>Voltar</QuestionnairePrevious>
            <QuestionnaireSkip>Pular</QuestionnaireSkip>
            <QuestionnaireNext>Continuar</QuestionnaireNext>
            <QuestionnaireSubmit>Concluir</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>

        <QuestionnaireItem name="detail" required>
          <QuestionnaireTitle>Qual o nível de detalhe?</QuestionnaireTitle>
          <QuestionnaireDescription>
            Define o estilo padrão das respostas do bot.
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice value="focused">
              Focado e direto
              <QuestionnaireChoiceDescription>
                Respostas curtas, só o essencial
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice value="complete">
              Completo e detalhado
              <QuestionnaireChoiceDescription>
                Contexto, exemplos e passo a passo
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>Voltar</QuestionnairePrevious>
            <QuestionnaireSkip>Pular</QuestionnaireSkip>
            <QuestionnaireNext>Continuar</QuestionnaireNext>
            <QuestionnaireSubmit>Concluir</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>

        <QuestionnaireItem name="purpose" required={false}>
          <QuestionnaireTitle>Pra que serve?</QuestionnaireTitle>
          <QuestionnaireDescription>
            Item livre e opcional — dá para pular sem responder.
          </QuestionnaireDescription>
          <QuestionnaireInput placeholder="Ex.: agendar reuniões, resumir e-mails…" />
          <QuestionnaireError />
          <QuestionnaireActions>
            <QuestionnairePrevious>Voltar</QuestionnairePrevious>
            <QuestionnaireSkip>Pular</QuestionnaireSkip>
            <QuestionnaireNext>Continuar</QuestionnaireNext>
            <QuestionnaireSubmit>Concluir</QuestionnaireSubmit>
          </QuestionnaireActions>
        </QuestionnaireItem>
      </Questionnaire>

      {payload ? (
        <div className="rounded-xl border bg-muted/40 p-4">
          <p className="text-xs font-medium text-muted-foreground">
            Payload do submit (FormData coletado — ainda não enviado ao
            backend):
          </p>
          <pre className="mt-2 overflow-x-auto text-xs leading-relaxed">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
