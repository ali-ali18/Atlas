// Portas de pagamento (F6.2 e F6.3). REGRA: número do cartão e CVV só existem dentro da camada de execução
// (`card_fill`). A tool `checkout` chama `CardFill.fill` e recebe um resultado SEM segredo; nunca vê o número, o CVV
// nem os dados de cobrança. O CVV viaja por um canal efêmero ligado ao pedido de aprovação e morre no primeiro uso.
import type { SavedCardSecrets } from "@workspace/shared";
import type { SecretValue } from "./vault.js";

/** O que o modelo e o cartão podem ver de um cartão salvo. */
export type CardInfo = { id: string; brand: string; last4: string; label: string };

/** Cofre de cartões: o dado completo sai só em `open`, dentro de um `SecretValue`, para a camada de execução. */
export interface CardVault {
	/** Bandeira e final do cartão do dono. `null` se o cartão não é dele. */
	describe(userId: string, cardId: string): Promise<CardInfo | null>;
	/** Só `card_fill` chama. `null` se o cartão não é do dono. `reveal()` devolve o JSON de `SavedCardSecrets`. */
	open(userId: string, cardId: string): Promise<{ info: CardInfo; secrets: SecretValue } | null>;
}

/** Quem pode ler o CVV: o pedido de aprovação (run + id do pedido, que já embute o hash dos argumentos) do dono. */
export type CvvScope = { userId: string; runId: string; requestId: string };

/** Canal efêmero do CVV. O valor nunca vai a banco, journal, checkpoint, log ou evento. */
export interface CvvEscrow {
	/** API: guarda o CVV para ESTE pedido, só se ainda não há um (set if not exists). `false` = já havia: o primeiro fica intacto. */
	deposit(scope: CvvScope, cvv: string, ttlMs: number): Promise<boolean>;
	/** Execução: lê e APAGA (uso único). `null` se não há (nunca depositado, já usado, expirado, outro pedido). */
	take(scope: CvvScope): Promise<SecretValue | null>;
	/** API: descarta sem ler (a decisão não foi gravada). */
	discard(scope: CvvScope): Promise<void>;
}

export type CardFillInput = {
	userId: string;
	runId: string;
	/** Id do pedido de aprovação que liberou a compra (chave do CVV). */
	approvalId: string;
	cardId: string;
	merchant: string;
	checkoutUrl: string;
	amount: number;
	currency: string;
};

/**
 * Livro durável de "pagamento iniciado", por pedido de aprovação. `start` grava ANTES de chamar a VM e devolve `false` se este
 * pedido já foi iniciado (uma retomada, uma segunda chamada ou outro processo): nesse caso a VM nunca é chamada de novo e o
 * resultado manda conferir a página do pedido. `release` só vale quando a VM sabidamente não chegou a agir; `settle` fecha o
 * pedido (pago ou à espera do dono). Falha ao gravar o livro = não paga (fail-closed).
 */
export interface PaymentLedger {
	start(scope: { userId: string; runId: string; approvalId: string }): Promise<boolean>;
	release(scope: { userId: string; runId: string; approvalId: string }): Promise<void>;
	settle(scope: { userId: string; runId: string; approvalId: string }): Promise<void>;
}

/** Resultado sem segredo. `challenge` = a loja abriu 3DS, app do banco ou captcha: o dono conclui na VM. */
export type CardFillResult =
	| { status: "paid"; orderRef?: string }
	| { status: "challenge"; kind: "3ds" | "bank_app" | "captcha" | "other" }
	| { status: "declined"; reason: string }
	| { status: "no_cvv" }
	| { status: "no_card" }
	| { status: "unavailable"; reason: string }
	| { status: "failed"; reason: string };

/**
 * CONTRATO DO ADAPTADOR REAL (F8, obrigatório): antes de pagar, ler na PÁGINA FINAL da loja o host que cobra e o total
 * cobrado. Se o host não for `merchant` (domínio da URL de pagamento aprovada) ou o total divergir de `amount`, devolver
 * `declined`/`failed` SEM pagar: o dono aprovou aquele valor naquela loja, e `amount`/`merchant` vêm do modelo.
 * O adaptador NUNCA grava `params` da ação `card_fill` (número, CVV, titular) em log, trace, journal, erro nem resultado.
 */
export interface CardFill {
	fill(input: CardFillInput, signal?: AbortSignal): Promise<CardFillResult>;
}

/** Ação enviada à porta `Sandbox` (formato da camada de execução; o adaptador da VM a interpreta). */
export type CardFillSandboxAction = {
	kind: "card_fill";
	params: { url: string; card: SavedCardSecrets; cvv: string; merchant: string; amount: number; currency: string; /** Pedido de aprovação: entra na chave de repetição da VM (a URL não entra). */ approvalId: string };
};
