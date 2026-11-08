// Adaptadores das portas de pagamento (F6.2, F6.3). Tudo por INJEÇÃO: o worker liga db, Redis, a caixa de segredos e a VM;
// este pacote não importa agent-runtime nem Redis.
//
// CAMINHO DO CVV (de onde entra a onde morre):
//   cartão de aprovação (campo) → POST .../respond (API: valida 3-4 dígitos) → `CvvEscrow.deposit` (selado, TTL curto,
//   chave = hash de dono+run+pedido de aprovação) → run retomado → `CardFill.fill` → `CvvEscrow.take` (lê e apaga, uso
//   único) → ação `card_fill` na VM → descartado. Não passa por banco, journal, checkpoint, log, evento nem tool.
import { createHash } from "node:crypto";
import { redactSecrets, type SavedCardSecrets } from "@workspace/shared";
import type { CardFill, CardFillInput, CardFillResult, CardFillSandboxAction, CardInfo, CardVault, CvvEscrow, CvvScope } from "../ports/payment.js";
import type { Sandbox } from "../ports/sandbox.js";
import type { SecretValue } from "../ports/vault.js";
import { sealSecretValue } from "./vault.js";

// -------------------------------------------------------------- cofre de cartões

export type CardVaultBackend = {
	/** Metadado público do cartão do dono (`null` se não é dele). */
	meta(userId: string, cardId: string): Promise<CardInfo | null>;
	/** Texto selado do cartão do dono (`null` se não é dele). */
	sealed(userId: string, cardId: string): Promise<string | null>;
	/** Abre o texto selado e devolve o JSON de `SavedCardSecrets`. */
	open(sealed: string): string;
};

export function createCardVaultAdapter(backend: CardVaultBackend): CardVault {
	return {
		describe: (userId, cardId) => backend.meta(userId, cardId),
		async open(userId, cardId) {
			const info = await backend.meta(userId, cardId);
			const sealed = info ? await backend.sealed(userId, cardId) : null;
			if (!info || sealed === null) return null;
			return { info, secrets: sealSecretValue(backend.open(sealed)) };
		},
	};
}

// -------------------------------------------------------------- canal efêmero do CVV

/** Subconjunto do Redis usado pelo canal (injetável em teste). */
export type EscrowBackend = {
	/** Com `nx`, só grava se a chave não existe (SET NX): devolve `false` se já havia valor, que fica intacto. */
	set(key: string, value: string, ttlMs: number, opts?: { nx?: boolean }): Promise<boolean>;
	/** Lê e apaga numa operação atômica (GETDEL). */
	getdel(key: string): Promise<string | null>;
	del(key: string): Promise<void>;
};

/** Caixa de segredos (AES-GCM com a chave do servidor). */
export type EscrowSealer = { seal(plain: string): string; open(sealed: string): string | null };

export const CVV_ESCROW_PREFIX = "atlas:v4:cvv:";
/** Quanto o CVV espera pelo run retomado. Passado disso a compra pede o cartão de novo. */
export const CVV_ESCROW_TTL_MS = 15 * 60_000;

/** Chave do pedido: hash de dono, run e pedido de aprovação (que já embute o hash dos argumentos). Outro pedido = outra chave. */
export function cvvEscrowKey(scope: CvvScope): string {
	return CVV_ESCROW_PREFIX + createHash("sha256").update(`${scope.userId}\u0000${scope.runId}\u0000${scope.requestId}`).digest("hex");
}

export function createCvvEscrow(backend: EscrowBackend, sealer: EscrowSealer): CvvEscrow {
	return {
		async deposit(scope, cvv, ttlMs) {
			const key = cvvEscrowKey(scope);
			// O selo leva a própria chave dentro: um valor copiado para a chave de outro pedido não abre.
			// NX: o CVV do primeiro clique de um pedido nunca é sobrescrito (nem apagado) por um segundo clique em corrida.
			return backend.set(key, sealer.seal(JSON.stringify({ bind: key, cvv })), ttlMs, { nx: true });
		},
		async take(scope) {
			const key = cvvEscrowKey(scope);
			const sealed = await backend.getdel(key);
			if (sealed === null) return null;
			const plain = sealer.open(sealed);
			if (plain === null) return null;
			try {
				const parsed = JSON.parse(plain) as { bind?: unknown; cvv?: unknown };
				return parsed.bind === key && typeof parsed.cvv === "string" ? sealSecretValue(parsed.cvv) : null;
			} catch {
				return null;
			}
		},
		async discard(scope) {
			await backend.del(cvvEscrowKey(scope));
		},
	};
}

// -------------------------------------------------------------- card_fill

export type CardFillDeps = { vault: CardVault; escrow: CvvEscrow; sandbox: Sandbox };

const CHALLENGE_KINDS = ["3ds", "bank_app", "captcha", "other"] as const;
type ChallengeKind = (typeof CHALLENGE_KINDS)[number];
const isChallengeKind = (v: unknown): v is ChallengeKind => typeof v === "string" && (CHALLENGE_KINDS as readonly string[]).includes(v);

const REASON_MAX = 300;

/** Variantes de texto do número para redigir (puro, com espaços em grupos de 4). */
function numberForms(number: string): string[] {
	const grouped = number.match(/.{1,4}/g)?.join(" ") ?? number;
	return [number, grouped, grouped.split(" ").join("-")];
}

/**
 * `card_fill`: junta cartão do cofre + CVV do canal efêmero e manda a ação à VM. Devolve só um resultado tipado, sem segredo.
 * Ordem: cartão (sem consumir o CVV se o cartão não é do dono) → CVV (uso único) → VM.
 */
export function createCardFill(deps: CardFillDeps): CardFill {
	return {
		async fill(input: CardFillInput, signal?: AbortSignal): Promise<CardFillResult> {
			const scope: CvvScope = { userId: input.userId, runId: input.runId, requestId: input.approvalId };
			const opened = await deps.vault.open(input.userId, input.cardId);
			if (!opened) {
				await deps.escrow.discard(scope);
				return { status: "no_card" };
			}
			const cvvSecret = await deps.escrow.take(scope);
			if (!cvvSecret) return { status: "no_cvv" };
			let card: SavedCardSecrets;
			try {
				card = JSON.parse(opened.secrets.reveal()) as SavedCardSecrets;
			} catch {
				return { status: "failed", reason: "The saved card could not be read." };
			}
			const cvv = cvvSecret.reveal();
			const known = [...numberForms(card.number), cvv, card.holder];
			const safe = (text: string) => redactSecrets(text, known).slice(0, REASON_MAX);
			const action: CardFillSandboxAction = { kind: "card_fill", params: { url: input.checkoutUrl, card, cvv, merchant: input.merchant, amount: input.amount, currency: input.currency } };
			try {
				const result = await deps.sandbox.run(input.userId, action, signal);
				if (!result.ok) return { status: "unavailable", reason: safe(result.error ?? "The computer is not available.") };
				return interpret(result.data, safe);
			} catch (error) {
				return { status: "failed", reason: safe(error instanceof Error ? error.message : String(error)) };
			}
		},
	};
}

function interpret(data: unknown, safe: (text: string) => string): CardFillResult {
	const d = (typeof data === "object" && data !== null ? data : {}) as { state?: unknown; kind?: unknown; orderRef?: unknown; reason?: unknown };
	if (d.state === "paid") return { status: "paid", ...(typeof d.orderRef === "string" && d.orderRef.length > 0 && { orderRef: safe(d.orderRef) }) };
	if (d.state === "challenge") return { status: "challenge", kind: isChallengeKind(d.kind) ? d.kind : "other" };
	if (d.state === "declined") return { status: "declined", reason: safe(typeof d.reason === "string" ? d.reason : "The card was declined.") };
	return { status: "failed", reason: safe(typeof d.reason === "string" ? d.reason : "The store did not confirm the payment.") };
}

export type { SecretValue };
