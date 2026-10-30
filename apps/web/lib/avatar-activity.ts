// O que o bot está fazendo (AgentActivity + status do run) → como o avatar se comporta.
// Pura: o texto do indicador e o avatar usam a mesma classificação de ferramentas
// (`toolKind` em working-status.ts). A parte com tempo (permanência mínima, brilho
// de progresso) vive em avatar-governor.ts.
import type { AvatarState } from "@workspace/ui/lib/avatar/model/behavior";

import { type AgentActivity, toolKind } from "./working-status";

export type AvatarRunContext = {
	/** Status do run no servidor (`waiting_user`, `paused`, `queued`…). */
	status?: string | null;
	paused?: boolean;
	/** Há um cartão de aprovação esperando o usuário. */
	pendingApproval?: boolean;
};

export type AvatarDesired = {
	state: AvatarState;
	/** Passo atual / total da chamada de ferramenta, quando o servidor informa. */
	step: number | null;
	/** Fração (passo + 1) / total, 0..1; `null` sem total conhecido. */
	progress: number | null;
};

/** Trabalhando mas sem detalhe (rotina, evento, outro dispositivo): gestos genéricos de trabalho. */
export const GENERIC_WORKING: AvatarDesired = { state: "working", step: null, progress: null };
export const IDLE_DESIRED: AvatarDesired = { state: "idle", step: null, progress: null };

const WAITING_STATUSES = new Set(["waiting_user", "waiting_external", "queued"]);

function toolState(tool: string): AvatarState {
	switch (toolKind(tool)) {
		case "navigate":
		case "web":
			return "searching";
		case "screenshot":
		case "memory":
		case "read":
			return "reading";
		case "code":
			return "coding";
		case "run":
			return "running";
		case "type":
		case "click":
		case "scroll":
		case "act":
			return "controlling";
		case "delegate":
		case "other":
			return "working";
	}
}

/** Fração do passo: o rótulo mostra "passo {step+1} de {max}", o anel mostra o mesmo. */
export function stepProgress(step: number | undefined, maxSteps: number | undefined): number | null {
	if (typeof step !== "number" || typeof maxSteps !== "number") return null;
	if (!Number.isFinite(step) || !Number.isFinite(maxSteps) || maxSteps <= 0) return null;
	return Math.min(1, Math.max(0, (step + 1) / maxSteps));
}

/**
 * Estado do avatar para a atividade atual.
 * - Esperando o usuário/aprovação/fila/pausa → `waiting` (órbita), tem prioridade.
 * - `revising` → `thinking`: o rascunho foi retirado e o chat não mostra texto, então
 *   o gesto de digitar (`streaming`) mentiria; as reticências dizem "pensando de novo".
 * - Ferramenta → família (pesquisa, leitura, código…); resultado com falha é tratado no governor.
 */
export function avatarStateForActivity(activity: AgentActivity, ctx: AvatarRunContext = {}): AvatarDesired {
	if (ctx.paused || ctx.pendingApproval || (ctx.status && (ctx.status === "paused" || WAITING_STATUSES.has(ctx.status)))) {
		return { state: "waiting", step: null, progress: null };
	}
	switch (activity.phase) {
		case "thinking":
		case "revising":
			return { state: "thinking", step: null, progress: null };
		case "writing":
			return { state: "streaming", step: null, progress: null };
		case "tool":
			return {
				state: toolState(activity.tool),
				step: typeof activity.step === "number" ? activity.step : null,
				progress: stepProgress(activity.step, activity.maxSteps),
			};
		case "idle":
			return GENERIC_WORKING;
	}
}
