// O executor do contrato: o ÚNICO caminho de toda chamada de tool (cláusulas 2, 3, 6, 7, 8, 11, 12).
// Ordem: classe de efeito → autorizador (metadado) → aprovação por token → execução → resultado
// sem segredo. O laço (kernel) só chama `executeCall`; nenhuma tool roda por outro caminho.
import type { BotLanguage } from "@workspace/shared";
import { copyFor } from "../copy/index.js";
import type { Ports } from "../ports/index.js";
import type { Tool } from "../tools/define-tool.js";
import type { RiskFacts, ToolContext } from "../tools/types.js";
import { type ApprovalGrant, type Hash, checkGrant, payloadHashOf, requestApproval } from "./approval.js";
import { type PolicyContext, authorize } from "./authorize.js";
import { RunProvenance } from "./provenance.js";
import type { CallOutcome } from "./outcome.js";
import { redactDeep, sanitizeText as redact } from "./sanitize.js";
import { checkSecretRefs, hasSecretRefs, injectSecretRefs, secretRefNames } from "./secret-refs.js";
import { storageSafe } from "./storage-text.js";

export type ExecutorDeps = {
	runId: string;
	ownerId: string;
	ports: Ports;
	hash: Hash;
	policy: PolicyContext;
	/** Proveniência do run. Para retomar, restaure de `ProvenanceSnapshot` (vai no checkpoint). */
	provenance?: RunProvenance;
	/** Valores do cofre usados neste run, para redigir mesmo sem padrão reconhecível. */
	secrets?: () => readonly string[];
	signal?: AbortSignal;
	/** Idioma do bot: os textos ao dono (`userMessage`) saem nele. Sem valor, vale o idioma de reserva do `copy`. */
	language?: BotLanguage;
	/** Usos do mandato que restam ao retomar (vem do checkpoint). Sem valor, vale `policy.mandate.usesLeft`. */
	mandateUsesLeft?: number;
	/** Chamado depois que o mandato gasta um uso (antes do efeito). */
	onMandateSpent?: (usesLeft: number) => void | Promise<void>;
	/**
	 * Gasto ATÔMICO do uso no armazém compartilhado (banco), antes do efeito: dois runs do mesmo dono nunca gastam o mesmo
	 * uso. `claim` falso = o mandato não tem mais uso (outro run gastou): o efeito NÃO roda. `release` devolve o uso quando
	 * a tool falhou sem pagar (ex.: o CVV não chegou). Sem isto vale só a contagem em memória do run.
	 */
	mandateUses?: { claim(): Promise<boolean>; release(): Promise<void> };
};

/** Uma chamada do modelo. `grant` vem da camada de fora (dono aprovou), nunca dos argumentos. */
export type ToolCall = { callId: string; step: number; tool: Tool; args: unknown; grant?: ApprovalGrant };

const HIDDEN_MESSAGE =
	"This action is not available in this context. Tell the owner what you would do and offer what is possible: a draft, a note, or preparing it for them to confirm in the chat. Do not retry it.";
const INTERRUPTED_HINT =
	"This write was started in an earlier attempt and never confirmed, so it may or may not have happened. Do not repeat it blindly: check the target first (or ask the owner), then decide.";
const IN_PROGRESS_HINT =
	"Another attempt is already running this exact write. Do not repeat it; check the target before deciding anything else.";
const ALREADY_DONE_HINT = "This exact call already finished successfully earlier in this run. Do not repeat it; use the receipt.";
const VAULT_DOWN_ERROR = "The owner's vault is unavailable right now. Nothing was run.";
const VAULT_DOWN_HINT = "Tell the owner the vault is unavailable; do not retry.";
/** Efeitos já tão estritos quanto `credential`: o uso de segredo não os troca. */
const STRICTER_THAN_CREDENTIAL: ReadonlySet<string> = new Set(["send", "money", "public_link", "destructive"]);
const HANDOFF_MESSAGE = "This step is always the owner's. Explain what they need to do and wait; do not attempt it.";

/** Redige segredos e troca os caracteres que o banco recusa (ver storage-text.ts). */
const sanitizeText = (text: string, secrets: readonly string[] = []) => storageSafe(redact(text, secrets));

export function createExecutor(deps: ExecutorDeps) {
	/** Pedidos de aprovação já executados neste run: o grant vale uma vez. */
	const consumed = new Set<string>();
	const provenance = deps.provenance ?? new RunProvenance();
	const secrets = () => deps.secrets?.() ?? [];
	/** Mandato vivo do run: cada efeito que roda por ele gasta um uso (S6). Só usos; o teto de valor é por execução. */
	let mandate = deps.policy.mandate && deps.mandateUsesLeft !== undefined ? { ...deps.policy.mandate, usesLeft: Math.min(deps.policy.mandate.usesLeft, deps.mandateUsesLeft) } : deps.policy.mandate;

	async function executeCall(call: ToolCall): Promise<CallOutcome> {
		const { tool, args } = call;
		// Usar o valor do cofre é uma ação de credencial, seja qual for o comando em volta: `echo {{secret:k}} | rev` "só lê",
		// mas devolve o segredo transformado ao modelo. Cartão em toda autonomia, fora sem dono, regra do dono não afrouxa.
		const usesSecret = tool.acceptsSecretRefs && hasSecretRefs(args);
		const baseEffect = tool.effectFor(args);
		const effect = usesSecret && !STRICTER_THAN_CREDENTIAL.has(baseEffect) ? "credential" : baseEffect;
		const secretNames = usesSecret ? secretRefNames(args) : [];
		/** Fato fixo no cartão: qual segredo do cofre a chamada usa. */
		const withSecretFact = (facts: RiskFacts | undefined): RiskFacts | undefined => {
			if (secretNames.length === 0) return facts;
			const fact = `usa o segredo ${secretNames.join(", ")} do cofre`;
			return { ...facts, target: facts?.target ? `${facts.target} (${fact})` : fact };
		};
		let riskFacts: RiskFacts | undefined = withSecretFact(tool.riskFactsFor(args));
		let payloadHash: string;
		try {
			payloadHash = payloadHashOf(tool.name, args, deps.hash);
		} catch (error) {
			return { status: "error", error: sanitizeText(`Arguments for ${tool.name} cannot be serialized: ${(error as Error).message}`, secrets()) };
		}

		const verdict = authorize({
			...deps.policy,
			...(mandate && { mandate }),
			effect,
			toolName: tool.name,
			handoffKind: tool.handoffKindFor(args),
			taint: { untrustedReadInRun: provenance.untrustedReadInRun, argsCarryUntrusted: provenance.carries(args), privateReadInRun: provenance.privateReadInRun },
			riskFacts,
			egress: tool.egressFor(args),
			confirm: tool.confirm,
			now: deps.ports.clock.now(),
		});

		if (verdict.kind === "handoff") return { status: "handoff", reason: verdict.reason, message: HANDOFF_MESSAGE, userMessage: copyFor(deps.language, "handoff") };
		if (verdict.kind === "hidden") return { status: "not_available", reason: verdict.reason, message: HIDDEN_MESSAGE, userMessage: copyFor(deps.language, "not_available") };

		// `{{secret:NOME}}` nos argumentos: confere os nomes (sem ler valor) antes de qualquer cartão ou journal.
		if (usesSecret) {
			let issue: Awaited<ReturnType<typeof checkSecretRefs>>;
			try {
				issue = await checkSecretRefs(deps.ownerId, deps.ports.vault, args);
			} catch {
				// Cofre fora do ar (ou erro de banco): texto fixo, sem a mensagem original, que pode carregar dado.
				return { status: "error", error: VAULT_DOWN_ERROR, hint: VAULT_DOWN_HINT };
			}
			if (issue) return { status: "error", error: sanitizeText(issue.error, secrets()), hint: issue.hint };
		}

		// Efeito (tudo que não é `read`) passa pelo journal: a retomada nunca repete escrita às cegas (cláusula 6).
		const effectful = effect !== "read";
		// Id de chamada com namespace do passo: provedor que repete `call_0` a cada passo não colide no journal nem nos pedidos de aprovação.
		const scopedCallId = `s${call.step}:${call.callId}`;
		const idempotencyKey = `${deps.runId}:${scopedCallId}:${payloadHash}`;
		const journalBase = { runId: deps.runId, userId: deps.ownerId, step: call.step, idempotencyKey, toolName: tool.name, argsHash: payloadHash } as const;
		let prior: Awaited<ReturnType<typeof deps.ports.store.journal.find>> = null;
		if (effectful) {
			prior = await deps.ports.store.journal.find(deps.ownerId, deps.runId, idempotencyKey);
			if (prior?.outcome === "started") return { status: "interrupted_write", hint: INTERRUPTED_HINT };
			if (prior?.outcome === "succeeded") return { status: "already_done", hint: ALREADY_DONE_HINT };
		}

		// Tool que precisa de um dado só do dono (CVV): com mandato vale o cartão "só o campo", nunca a execução direta.
		const inputOnly = verdict.kind === "run" && verdict.reason === "mandate" && tool.ownerInput !== undefined;
		let approvalId: string | undefined;
		if (verdict.kind === "approve" || inputOnly) {
			// O cartão mostra o que será feito de verdade (ex.: o evento a apagar): a tool completa os fatos com uma leitura. O id do pedido não depende deles.
			// Só ao pedir: a retomada já aprovada (com grant) não relê, o cartão não será mostrado de novo.
			if (!call.grant) riskFacts = withSecretFact(await tool.enrichedRiskFactsFor(args, { ownerId: deps.ownerId, ...(deps.signal && { signal: deps.signal }) }));
			const request = requestApproval({ runId: deps.runId, callId: scopedCallId, toolName: tool.name, effect, args, riskFacts, hash: deps.hash, secrets: secrets(), ...(tool.ownerInput && { ownerInput: tool.ownerInput }), ...(inputOnly && { inputOnly: true }) });
			approvalId = request.id;
			if (!call.grant) return { status: "pending_approval", request };
			// O grant só é consumido junto com o claim do journal. Entrada `failed` = o efeito já gastou este grant (talvez em
			// outro processo, onde `consumed` está vazio): não vale de novo (S5).
			if (prior?.outcome === "failed") return { status: "approval_invalid", reason: "approval already used", request };
			const check = checkGrant(call.grant, request, consumed);
			if (!check.ok) return { status: "approval_invalid", reason: check.reason, request };
			consumed.add(request.id);
		}

		// Aprovado (ou livre): só agora o valor sai do cofre, e só para a tool. `args` (cartão, hash, journal) fica com o marcador.
		let runArgs: unknown = args;
		if (usesSecret) {
			let injected: Awaited<ReturnType<typeof injectSecretRefs>>;
			try {
				injected = await injectSecretRefs(deps.ownerId, deps.ports.vault, args);
			} catch {
				return { status: "error", error: VAULT_DOWN_ERROR, hint: VAULT_DOWN_HINT };
			}
			if (!injected.ok) return { status: "error", error: sanitizeText(injected.error, secrets()), hint: injected.hint };
			runArgs = injected.args;
		}

		let spentUse = false;
		if (effectful) {
			// Worker zumbi: sem lease vigente não há efeito. Depois, o claim atômico do journal (S5).
			await deps.ports.store.runs.assertLease?.(deps.ownerId, deps.runId);
			const claim = await deps.ports.store.journal.append({ ...journalBase, outcome: "started" });
			if (!claim.claimed) return { status: "already_in_progress", hint: IN_PROGRESS_HINT };
			// O efeito vai rodar por causa do mandato: gasta um uso ANTES de executar (os efeitos do passo são em série).
			if (mandate && verdict.kind === "run" && verdict.reason === "mandate") {
				if (deps.mandateUses && !(await deps.mandateUses.claim())) {
					// Outro run gastou o último uso desde que este começou: sem uso não há mandato, nada é pago.
					await deps.ports.store.journal.append({ ...journalBase, outcome: "failed" });
					mandate = { ...mandate, usesLeft: 0 };
					return { status: "error", error: "The owner's purchase allowance has no uses left, so nothing was paid.", hint: "Tell the owner plainly and ask them to confirm the purchase again; do not retry on your own." };
				}
				mandate = { ...mandate, usesLeft: mandate.usesLeft - 1 };
				spentUse = true;
				await deps.onMandateSpent?.(mandate.usesLeft);
			}
		}
		const ctx: ToolContext = { runId: deps.runId, ownerId: deps.ownerId, ports: deps.ports, signal: deps.signal, callId: scopedCallId, untrustedReadInRun: provenance.untrustedReadInRun, ...(approvalId && { approvalId }) };
		const result = await tool.run(runArgs, ctx);
		// Dado de fonte não confiável marca o run ANTES de voltar ao modelo (vale também para o texto de erro).
		// Redigido ANTES de registrar: a proveniência vai no checkpoint e não pode guardar segredo que a tool deixou escapar.
		if (tool.privateData && result.ok) provenance.markPrivateRead();
		if (tool.trust === "untrusted" && tool.source) provenance.record(sanitizeText(result.ok ? result.summary : result.error, secrets()), tool.source);
		if (!result.ok) {
			// Falhou sem pagar (ex.: sem CVV): o uso do mandato volta, para não gastar mandato sem compra.
			if (spentUse && deps.mandateUses) {
				await deps.mandateUses.release().catch(() => undefined);
				if (mandate) mandate = { ...mandate, usesLeft: mandate.usesLeft + 1 };
			}
			if (effectful) await deps.ports.store.journal.append({ ...journalBase, outcome: "failed" });
			return { status: "error", error: sanitizeText(result.error, secrets()), ...(result.hint && { hint: sanitizeText(result.hint, secrets()) }) };
		}
		// Efeito de credencial que a tool tratava como leitura (shell, leitura de conector) não traz recibo: o executor registra
		// o uso do segredo, para a regra "efeito sem recibo é bug" continuar valendo para o resto.
		const receipt = result.receipt ?? (effectful && usesSecret ? { what: `Ran with a vault secret: ${secretNames.join(", ")}` } : undefined);
		if (effectful) {
			if (!receipt) {
				// O efeito pode ter acontecido: registra como feito (não repetir) e acusa a tool, nunca "sucesso".
				await deps.ports.store.journal.append({ ...journalBase, outcome: "succeeded" });
				return { status: "contract_error", error: `${tool.name} has effect "${effect}" but returned no receipt. Report this as a bug; do not retry the call.` };
			}
			const { what, where, externalId, url } = receipt;
			await deps.ports.store.receipts.append({
				runId: deps.runId,
				userId: deps.ownerId,
				toolName: tool.name,
				effect,
				summary: sanitizeText(what, secrets()),
				...(where && { where: sanitizeText(where, secrets()) }),
				...(externalId && { externalId: sanitizeText(externalId, secrets()) }),
				...(url && { url: sanitizeText(url, secrets()) }),
				at: deps.ports.clock.now(),
			});
			await deps.ports.store.journal.append({ ...journalBase, outcome: "succeeded" });
		}
		return { status: "ok", summary: sanitizeText(result.summary, secrets()), ...(receipt && { receipt: redactDeep(receipt, secrets()) }), ...(result.park && { park: result.park }) };
	}

	return { executeCall, provenance, mandateUsesLeft: () => mandate?.usesLeft };
}

export type Executor = ReturnType<typeof createExecutor>;
