// Porta `Sandbox` real do v4 no worker (F8.0): a VM do navegador é a mesma do v2, escopada por USUÁRIO + CONVERSA
// (`createSandboxManager(config, userId)`, volumes e perfil do Chrome por conversa). O adaptador é POR RUN: o dono e a
// conversa vêm do run, nunca da ação (que vem do modelo/da capacidade). Pedir a VM de outro dono é recusado, e o manager
// ainda confere a posse da sessão por conta própria (`session-store`).
//
// COMO UMA CAPACIDADE LIGA UM `kind` NOVO (frentes `browser` e `code`): escreva um `SandboxKindHandler` no módulo dela e
// registre UMA linha em `defaultSandboxHandlers` (ou passe `handlers` ao criar o adaptador). O handler recebe a sessão da VM
// já resolvida e o `manager` para falar com o control server; o adaptador cuida de escopo, sessão, cancelamento e `release`.
import { VAULT_KINDS, type Sandbox, type SandboxAction, type SandboxResult } from "@workspace/agent";
import { createSandboxManager, loadSandboxConfig, type SandboxManager, type SandboxRuntimeConfig } from "@workspace/sandbox";
import { browserKindHandlers } from "./sandbox-browser.js";
import { cardFillHandler } from "./sandbox-card-fill.js";
import { loginFillHandler } from "./sandbox-vault-login.js";
import { videoKindHandlers } from "./sandbox-video.js";
import type { CodeActionHandler } from "./code-actions.js";
import { realCodeActionHandler } from "./code-actions-real.js";

export type SandboxKindContext = {
	/** Dono do run (a sessão): o escopo de tudo. */
	userId: string;
	runId: string;
	/** Sessão da VM do run, já resolvida. */
	sessionId: string;
	manager: SandboxManager;
	signal?: AbortSignal;
};
export type SandboxKindHandler = (ctx: SandboxKindContext, params: unknown) => Promise<SandboxResult>;

/**
 * Um `kind` por linha. `card_fill` (F8.0) e `browser.*` (F8.1) usam a VM da conversa. `code.*` (F8.2) NÃO passa por aqui: a
 * sessão de código é de outro ambiente (dev sandbox, escopo usuário + sessão), então tem o seu tratador (`input.code`).
 */
export const defaultSandboxHandlers: Readonly<Record<string, SandboxKindHandler>> = {
	card_fill: cardFillHandler,
	[VAULT_KINDS.loginFill]: loginFillHandler,
	...browserKindHandlers,
	...videoKindHandlers,
};

export type V4SandboxDeps = {
	/** Um manager por chamada: o `signal` do run vira o contexto de execução (cancelar o run corta a espera pela VM). */
	createManager(userId: string, signal?: AbortSignal): SandboxManager;
};

export type V4SandboxScope = { userId: string; runId: string; conversationId: string | null };

const UNAVAILABLE = "The computer (virtual machine and browser) could not be started right now. Tell the owner plainly, and offer an alternative that does not need it.";

export function createV4Sandbox(input: { scope: V4SandboxScope; /** `null` = sem VM de navegador (só `code.*`, se houver). */ deps: V4SandboxDeps | null; /** Tratador de `code.*` (dev sandbox). Sem ele, `code.*` não é suportado. */ code?: CodeActionHandler; handlers?: Record<string, SandboxKindHandler>; log?: (message: string) => void }): Sandbox & { /** Teste e telemetria. */ readonly activeSessionId: () => string | null } {
	const { scope } = input;
	const handlers = { ...defaultSandboxHandlers, ...input.handlers };
	const log = input.log ?? (() => undefined);
	// Uma resolução por run: as ações seguintes reaproveitam a mesma sessão (e a mesma VM da conversa).
	let session: Promise<{ sessionId: string; ephemeral: boolean }> | null = null;
	let resolved: string | null = null;

	const resolveSession = (signal?: AbortSignal) => {
		if (!input.deps) return Promise.reject(new Error("browser VM disabled"));
		session ??= input.deps
			.createManager(scope.userId, signal)
			.resolveSession(scope.conversationId ?? undefined)
			.then((response) => {
				resolved = response.sessionId;
				return { sessionId: response.sessionId, ephemeral: !scope.conversationId };
			})
			.catch((error: unknown) => {
				session = null;
				resolved = null;
				throw error;
			});
		return session;
	};

	return {
		activeSessionId: () => resolved,
		async run(userId: string, action: SandboxAction, signal?: AbortSignal): Promise<SandboxResult> {
			if (userId !== scope.userId) return { ok: false, error: "That computer belongs to another owner, so nothing was done." };
			// `code.*` vai para a sessão de código do dono (nunca sobe a VM do navegador à toa).
			if (input.code?.handles(action.kind)) return input.code.run(userId, action, signal);
			const handler = handlers[action.kind];
			if (!handler) return { ok: false, error: `The computer does not support the action "${String(action.kind).slice(0, 40)}" in this version. Tell the owner plainly and offer an alternative.` };
			let ready: { sessionId: string };
			try {
				ready = await resolveSession(signal);
			} catch (error) {
				// Nada do pedido foi enviado: o motivo técnico fica no log do servidor (sem o corpo da ação), o modelo recebe a frase honesta.
				log(`[engine-v4] run=${scope.runId} sandbox indisponível: ${error instanceof Error ? error.name : "erro"}`);
				return { ok: false, error: UNAVAILABLE };
			}
			return handler({ userId: scope.userId, runId: scope.runId, sessionId: ready.sessionId, manager: input.deps!.createManager(scope.userId, signal), ...(signal && { signal }) }, action.params);
		},
		async release(userId: string, runId: string): Promise<void> {
			if (userId !== scope.userId || runId !== scope.runId || !session) return;
			const pending = session;
			session = null;
			resolved = null;
			try {
				const { sessionId, ephemeral } = await pending;
				// A VM da conversa fica ligada (o reaper e o guarda de memória cuidam dela; o dono pode estar no viewer concluindo
				// um 3DS). Só a VM sem conversa, criada para este run, é destruída.
				if (ephemeral) await input.deps?.createManager(scope.userId).destroySession(sessionId);
			} catch {
				// liberar é melhor esforço
			}
		},
	};
}

/** Configuração de produção, ou `null` quando a VM está desligada (SANDBOX_ENABLED=0): o run segue com a VM indisponível. */
export function realV4SandboxDeps(env: NodeJS.ProcessEnv = process.env): V4SandboxDeps | null {
	const config: SandboxRuntimeConfig = loadSandboxConfig(env);
	if (!config.enabled) return null;
	return { createManager: (userId, signal) => createSandboxManager(config, userId, signal ? { signal } : {}) };
}

/** O que o run tem de verdade: a VM do navegador e/ou o ambiente de código. Decide `browser`/`code` no preset. */
export type RunSandboxAvailability = { vm: boolean; code: boolean };

/**
 * Porta `Sandbox` do run, ou `undefined` sem nenhuma das duas (o motor então usa `unavailableSandbox`, com o erro honesto).
 * Não sobe nada: a VM só nasce na primeira ação. `code` só é montado quando o chamador pede (o bot ligou o modo de código) E o
 * ambiente de código está configurado (`DEV_SANDBOX_ENABLED`).
 */
export function createRunSandbox(input: { scope: V4SandboxScope; env?: NodeJS.ProcessEnv; wantCode?: boolean; log?: (message: string) => void }): (ReturnType<typeof createV4Sandbox> & { readonly availability: RunSandboxAvailability }) | undefined {
	const deps = realV4SandboxDeps(input.env);
	const code = input.wantCode ? realCodeActionHandler({ conversationId: input.scope.conversationId, ...(input.env && { env: input.env }) }) : null;
	if (!deps && !code) return undefined;
	const sandbox = createV4Sandbox({ scope: input.scope, deps, ...(code && { code }), ...(input.log && { log: input.log }) });
	return Object.assign(sandbox, { availability: { vm: deps !== null, code: code !== null } });
}
