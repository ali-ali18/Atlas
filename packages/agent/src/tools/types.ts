import type { Ports } from "../ports/index.js";

/** Contexto que o laço entrega a toda tool e a todo gancho. Não leva texto do assistente. */
export type ToolContext = {
	runId: string;
	ownerId: string;
	ports: Ports;
	signal?: AbortSignal;
	/** Id desta chamada, único no run e estável na retomada (`s<passo>:<id da chamada>`). Tools usam para ids determinísticos, sem estado em memória. */
	callId?: string;
	/** Alguma tool não confiável (e-mail, web, arquivo…) já devolveu resultado neste run. Tools que GUARDAM texto para depois (agenda) marcam a origem. */
	untrustedReadInRun?: boolean;
	/**
	 * Id do pedido de aprovação que liberou esta chamada (só quando passou por cartão). Serve de CHAVE do canal efêmero
	 * do CVV (F6.3): a tool o repassa à porta de pagamento, nunca guarda nem mostra o segredo.
	 */
	approvalId?: string;
};

/**
 * Fatos de risco que o cartão de aprovação mostra (cláusula 3). Só metadados tipados tirados dos
 * argumentos pela própria tool, nunca texto do modelo nem corpo de e-mail/página (cláusula 7).
 */
export type RiskFacts = {
	amount?: number;
	currency?: string;
	merchant?: string;
	/** Todos os destinatários (pessoas, bots, endereços). */
	recipients?: readonly string[];
	/** Subconjunto de `recipients` fora do Atlas e fora do círculo do dono. */
	externalRecipients?: readonly string[];
	/** Não dá para desfazer. */
	irreversible?: boolean;
	/** Onde o efeito acontece: conta, arquivo, URL, calendário… */
	target?: string;
	/** Itens da compra, uma linha cada (cartão de compra). */
	items?: readonly string[];
	/** Frete, na moeda de `currency`. */
	shipping?: number;
	/** Desconto (cupom) já abatido de `amount`, na moeda de `currency`. */
	discount?: number;
	/** Cartão que paga, só bandeira e final ("Visa final 1111"). Nunca o número. */
	card?: string;
};

/** Recibo mínimo de uma tool de efeito. A F1.6 o torna o `Receipt` do journal. */
export type ToolReceipt = {
	what: string;
	where?: string;
	externalId?: string;
	url?: string;
};

/** Sucesso sempre com `summary`; falha sempre com `error` real. Nunca `ok:true` com texto de erro. */
export type ToolResult =
	| { ok: true; summary: string; receipt?: ToolReceipt; /** O efeito já foi feito, mas o resto é do dono (3DS, app do banco, captcha): o run estaciona com handoff. */ park?: "handoff"; error?: never }
	| { ok: false; error: string; hint?: string; summary?: never };
