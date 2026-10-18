"use client";

import { useCallback, useRef, useState } from "react";
import type { ConfirmStatus } from "@workspace/ui/components/confirm-alert";
import type { UpdateBotInput } from "@workspace/shared";
import { updateBot as updateBotRequest } from "@/lib/atlas-api";
import {
  buildBotProfileProposalFromAnswers,
  buildBotProfileProposalFromPatch,
  getProposalPatch,
  type BotProfileProposal,
  type BotProfileSnapshot,
  type QuestionnaireAnswers,
} from "./bot-profile-proposal";

type UpdateBotFn = (id: string, patch: UpdateBotInput) => Promise<unknown>;

/**
 * Fluxo mínimo: questionário -> proposta -> confirm -> PATCH.
 * - 1 proposta por vez (propor substitui a anterior).
 * - confirmar aplica via `PATCH /v1/bots/:id` (updateBotRequest).
 * - editar volta ao campo (via `onEditRequest`), dispensar descarta sem PATCH.
 * - duplo confirm é no-op (trava `isApplying` + `status`).
 */
export function useBotProfileProposal(options?: {
  updateBot?: UpdateBotFn;
  onEditRequest?: (proposal: BotProfileProposal) => void;
}) {
  const updateFnRef = useRef<UpdateBotFn>(options?.updateBot ?? updateBotRequest);
  updateFnRef.current = options?.updateBot ?? updateBotRequest;
  const onEditRef = useRef(options?.onEditRequest);
  onEditRef.current = options?.onEditRequest;

  const [proposal, setProposal] = useState<BotProfileProposal | null>(null);
  const [status, setStatus] = useState<ConfirmStatus>("pending");
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Trava síncrona contra duplo clique (state sozinho perde na mesma tick). */
  const applyingRef = useRef(false);

  /** AgentRun gerou `after` (UpdateBotInput) a partir das respostas. */
  const proposeFromPatch = useCallback(
    (input: { botId: string; current: BotProfileSnapshot; patch: UpdateBotInput }) => {
      const next = buildBotProfileProposalFromPatch(input);
      setError(null);
      setStatus("pending");
      setIsApplying(false);
      applyingRef.current = false;
      // 1 proposta por vez: substitui a anterior, nunca empilha.
      setProposal(next);
      return next;
    },
    [],
  );

  /** Atalho sem LLM: respostas do questionário -> proposta. */
  const proposeFromAnswers = useCallback(
    (input: { botId: string; current: BotProfileSnapshot; answers: QuestionnaireAnswers }) => {
      const next = buildBotProfileProposalFromAnswers(input);
      setError(null);
      setStatus("pending");
      setIsApplying(false);
      applyingRef.current = false;
      // 1 proposta por vez: substitui a anterior, nunca empilha.
      setProposal(next);
      return next;
    },
    [],
  );

  /** Confirmar = aplicar PATCH uma única vez (só campos mudados). */
  const confirm = useCallback(async () => {
    const current = proposal;
    if (!current || applyingRef.current || isApplying || status !== "pending") return false;
    applyingRef.current = true;
    setIsApplying(true);
    setError(null);
    try {
      // PATCH acontece aqui: PATCH /v1/bots/:id via updateBotRequest.
      // getProposalPatch retorna só `after` (campos que mudaram). Memória fica p/ outra tarefa.
      await updateFnRef.current(current.botId, getProposalPatch(current));
      setStatus("approved");
      return true;
    } catch (err) {
      // Erro mantém pendente (permite retry) com mensagem PT-BR visível.
      const detail = err instanceof Error ? err.message.trim() : "";
      setError(
        detail
          ? `Não foi possível aplicar. ${detail} Tente de novo.`
          : "Não foi possível aplicar. Tente de novo.",
      );
      return false;
    } finally {
      applyingRef.current = false;
      setIsApplying(false);
    }
  }, [proposal, isApplying, status]);

  /** Editar = volta ao campo, mantém proposta pendente (sem PATCH). */
  const edit = useCallback(() => {
    if (!proposal || status !== "pending") return;
    onEditRef.current?.(proposal);
  }, [proposal, status]);

  /** Dispensar = descarta sem PATCH. */
  const dismiss = useCallback(() => {
    if (!proposal || status !== "pending") return;
    setStatus("rejected");
    setProposal(null);
    setError(null);
  }, [proposal, status]);

  const reset = useCallback(() => {
    setProposal(null);
    setStatus("pending");
    setIsApplying(false);
    applyingRef.current = false;
    setError(null);
  }, []);

  return {
    proposal,
    status,
    isApplying,
    error,
    proposeFromPatch,
    proposeFromAnswers,
    confirm,
    edit,
    dismiss,
    reset,
  };
}
