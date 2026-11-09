// Porta `Vault`: cofre de segredos.
// REGRA: o segredo é resolvido por HANDLE na camada de execução (ex.: preencher
// login) e NUNCA volta para a camada do modelo. O modelo vê só o handle e um
// rótulo; contexto, eventos, journal e mensagens não podem conter o valor.

/**
 * O que o modelo pode ver de um item do cofre. `id` é o NOME do item (é o que vai em `{{secret:NOME}}` e em `login_fill`).
 * `kind`, `site` e `username` são metadados (nunca o valor): login mostra o site e o usuário; senha e código 2FA ficam fora.
 */
export type SecretHandle = {
	id: string;
	label: string;
	/** `secret` = valor simples (chave, token); `login` = usuário e senha de um site. Ausente = `secret`. */
	kind?: "secret" | "login";
	/** Para que serve (texto do dono). */
	description?: string;
	/** Login: domínio do site salvo. Ausente = o item não tem site (o `login_fill` recusa). */
	site?: string;
	/** Login antigo: usuário (claro). Login novo não tem: os campos ficam em `fields`. */
	username?: string;
	/** Login: os campos salvos (só chave, rótulo e se é secreto; nunca valor). Login antigo aparece como `username` + `password`. */
	fields?: ReadonlyArray<{ key: string; label: string; secret: boolean }>;
};

/** Valor resolvido: usar só dentro do executor e descartar. */
export type SecretValue = { reveal(): string };

export interface Vault {
	/** O que o modelo pode ver: handles e rótulos, nunca valores. */
	listHandles(userId: string): Promise<SecretHandle[]>;
	/** Só a camada de execução chama; `null` se o handle não é do dono. Só segredo simples (`kind: "secret"`): a senha de um login só vai à VM por `login_fill`. */
	resolve(userId: string, handleId: string): Promise<SecretValue | null>;
}

/**
 * Pedido ao dono para cadastrar segredos que faltam. O dono digita o valor num campo de senha do cartão e ele vai direto ao
 * cofre (API), nunca pela conversa nem pelo modelo. A resposta chega depois como uma mensagem comum do dono.
 */
export type SecretRequest = {
	/** Segredo simples: os nomes. Login: as chaves dos campos pedidos (um campo de digitar por chave). */
	names: readonly string[];
	reason: string;
	/** Pedido de LOGIN (F9): o site e os campos desta etapa, declarados pelo modelo. Tudo vai para um item só daquele site. */
	login?: { site: string; name?: string; fields: ReadonlyArray<{ key: string; label: string; secret: boolean }> };
};

export interface SecretRequests {
	/** Mostra o cartão ao dono (e o grava na conversa). Lança com o motivo real se não houver como pedir (ex.: sem conversa). */
	ask(userId: string, runId: string, request: SecretRequest): Promise<void>;
}
