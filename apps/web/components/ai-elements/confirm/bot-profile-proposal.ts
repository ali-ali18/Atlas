"use client";

import type { UpdateBotInput } from "@workspace/shared";
import { defaultTranslator, type MessageKey, type Translator } from "@/lib/i18n/translator";

/** Campos do perfil que a IA pode propor corrigir (nada de memória). */
export type BotProfileField =
  | "description"
  | "snippet"
  | "openRouterModel"
  | "name";

export const BOT_PROFILE_FIELDS: readonly BotProfileField[] = [
  "description",
  "snippet",
  "openRouterModel",
  "name",
] as const;

/** Chaves dos rótulos curtos do antes/depois (o texto vem do idioma da tela). */
export const BOT_PROFILE_FIELD_KEYS = {
  description: "aiElements.profile.field.description",
  snippet: "aiElements.profile.field.snippet",
  openRouterModel: "aiElements.profile.field.openRouterModel",
  name: "aiElements.profile.field.name",
} as const satisfies Record<BotProfileField, MessageKey>;

/** Rótulos curtos pt-BR (idioma-fonte) para o antes/depois. */
export const BOT_PROFILE_FIELD_LABELS: Record<BotProfileField, string> = {
  description: defaultTranslator.t(BOT_PROFILE_FIELD_KEYS.description),
  snippet: defaultTranslator.t(BOT_PROFILE_FIELD_KEYS.snippet),
  openRouterModel: defaultTranslator.t(BOT_PROFILE_FIELD_KEYS.openRouterModel),
  name: defaultTranslator.t(BOT_PROFILE_FIELD_KEYS.name),
};

const MAX_LEN: Record<BotProfileField, number> = {
  description: 2000,
  snippet: 140,
  openRouterModel: 120,
  name: 80,
};

export type BotProfileSnapshot = {
  name: string;
  snippet: string;
  description: string | null;
  openRouterModel: string | null;
};

/** Respostas curtas do questionário (1 pergunta por vez na UI). */
export type QuestionnaireAnswers = {
  briefing?: string;
  snippet?: string;
  model?: string;
  name?: string;
};

/**
 * Proposta de autocorreção do perfil com gate humano.
 * `before` = perfil atual, `after` = patch validado (só o que mudou).
 */
export type BotProfileProposal = {
  botId: string;
  /** ID da proposta persistida (thread). Ausente no fluxo local de teste. */
  proposalId?: string;
  before: BotProfileSnapshot;
  after: UpdateBotInput;
  fields: BotProfileField[];
};

export type BotProfileRow = {
  field: BotProfileField;
  label: string;
  before: string;
  after: string;
};

function normStr(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function snapshotOf(current: BotProfileSnapshot): BotProfileSnapshot {
  return {
    name: current.name ?? "",
    snippet: current.snippet ?? "",
    description: current.description ?? null,
    openRouterModel: current.openRouterModel ?? null,
  };
}

function toDisplay(value: string | null | undefined): string {
  const t = typeof value === "string" ? value.trim() : "";
  return t.length > 0 ? t : "—";
}

/** Monta `after` a partir de patch bruto (ex: JSON gerado pelo AgentRun). */
export function buildBotProfileProposalFromPatch(input: {
  botId: string;
  current: BotProfileSnapshot;
  patch: UpdateBotInput;
}): BotProfileProposal | null {
  const botId = input.botId.trim();
  if (!botId) return null;
  const before = snapshotOf(input.current);
  const after: UpdateBotInput = {};
  const fields: BotProfileField[] = [];

  const desc = normStr(input.patch.description, MAX_LEN.description);
  // description aceita null (limpar), mas só propõe limpar se explícito.
  if (desc !== null && desc !== (before.description ?? "").trim()) {
    after.description = desc;
    fields.push("description");
  } else if (input.patch.description === null && before.description !== null) {
    after.description = null;
    fields.push("description");
  }

  const snip = normStr(input.patch.snippet, MAX_LEN.snippet);
  if (snip !== null && snip !== before.snippet.trim()) {
    after.snippet = snip;
    fields.push("snippet");
  }

  const model = normStr(input.patch.openRouterModel, MAX_LEN.openRouterModel);
  if (model !== null && model !== (before.openRouterModel ?? "").trim()) {
    after.openRouterModel = model;
    fields.push("openRouterModel");
  }

  const name = normStr(input.patch.name, MAX_LEN.name);
  if (name !== null && name !== before.name.trim()) {
    after.name = name;
    fields.push("name");
  }

  if (fields.length === 0) return null;
  return { botId, before, after, fields };
}

/** Atalho: respostas do questionário -> proposta (sem LLM, heurística). */
export function buildBotProfileProposalFromAnswers(input: {
  botId: string;
  current: BotProfileSnapshot;
  answers: QuestionnaireAnswers;
}): BotProfileProposal | null {
  return buildBotProfileProposalFromPatch({
    botId: input.botId,
    current: input.current,
    patch: {
      ...(input.answers.briefing !== undefined
        ? { description: input.answers.briefing }
        : {}),
      ...(input.answers.snippet !== undefined
        ? { snippet: input.answers.snippet }
        : {}),
      ...(input.answers.model !== undefined
        ? { openRouterModel: input.answers.model }
        : {}),
      ...(input.answers.name !== undefined ? { name: input.answers.name } : {}),
    },
  });
}

/** Patch pronto para `PATCH /v1/bots/:id`. */
export function getProposalPatch(proposal: BotProfileProposal): UpdateBotInput {
  return { ...proposal.after };
}

/** Linhas de antes/depois para renderizar no confirm-card. */
export function getProposalRows(proposal: BotProfileProposal, { t }: Translator = defaultTranslator): BotProfileRow[] {
  return proposal.fields.map((field) => {
    const label = t(BOT_PROFILE_FIELD_KEYS[field]);
    switch (field) {
      case "description":
        return {
          field,
          label,
          before: toDisplay(proposal.before.description),
          after: toDisplay(
            typeof proposal.after.description === "string"
              ? proposal.after.description
              : null,
          ),
        };
      case "snippet":
        return {
          field,
          label,
          before: toDisplay(proposal.before.snippet),
          after: toDisplay(
            typeof proposal.after.snippet === "string"
              ? proposal.after.snippet
              : undefined,
          ),
        };
      case "openRouterModel":
        return {
          field,
          label,
          before: toDisplay(proposal.before.openRouterModel),
          after: toDisplay(
            typeof proposal.after.openRouterModel === "string"
              ? proposal.after.openRouterModel
              : undefined,
          ),
        };
      case "name":
        return {
          field,
          label,
          before: toDisplay(proposal.before.name),
          after: toDisplay(
            typeof proposal.after.name === "string"
              ? proposal.after.name
              : undefined,
          ),
        };
    }
  });
}

/** Título curto (ex: "Atualizar perfil?"). */
export function getProposalTitle(proposal: BotProfileProposal, { t, locale }: Translator = defaultTranslator): string {
  if (proposal.fields.length === 1) {
    return t("aiElements.profile.titleOne", { field: t(BOT_PROFILE_FIELD_KEYS[proposal.fields[0]!]).toLocaleLowerCase(locale) });
  }
  return t("aiElements.profile.titleMany");
}
