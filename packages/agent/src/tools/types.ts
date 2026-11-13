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
 * Fatos de risco que o cartão de aprovação mostra (cláusula 3). Só dados tipados tirados dos argumentos
 * (ou lidos pela própria tool), nunca texto livre do modelo como instrução. O texto que o dono vê é montado
 * no front, no idioma dele, a partir destes campos; por isso `event` e `message` são estruturados.
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
	/** Evento de agenda a que o pedido se refere (criar, alterar, apagar). */
	event?: RiskEvent;
	/** E-mail que vai sair (o dono lê o que será enviado, não só para quem). */
	message?: RiskMessage;
};

/** Evento do cartão de aprovação. `start`/`end` são instantes ISO (ou datas, se `allDay`) para o front formatar no fuso `timeZone`. */
export type RiskEvent = {
	action: "create" | "update" | "delete";
	/** Ausente quando a tool ainda não leu o evento (apagar/alterar sem conseguir buscá-lo). */
	title?: string;
	start?: string;
	end?: string;
	allDay?: boolean;
	timeZone?: string;
	location?: string;
	/** Convidados que o evento passa a ter (criar/alterar) ou tem (apagar). */
	guests?: readonly string[];
	/** Os convidados recebem e-mail por causa deste pedido. */
	notifyGuests?: boolean;
};

/** E-mail do cartão de aprovação: o corpo inteiro, para o dono ler antes de aprovar. */
export type RiskMessage = {
	subject?: string;
	body: string;
	/** De onde sai: `gmail` (conta do dono) ou `bot` (caixa do bot). */
	from?: "gmail" | "bot";
	/** É resposta a uma conversa. */
	reply?: boolean;
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
