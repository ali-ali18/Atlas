# PLANO-COMPOSIO

Provedor de conectores **opcional** via [Composio](https://composio.dev), com a chave do próprio usuário (BYO key). O Atlas não paga nada.

## Decisões

1. **Opcional.** Só ativa quando o usuário salva a própria chave. Sem chave nada muda: conectores nativos e Marketplace seguem como hoje. Remover a chave apaga a conexão e (melhor esforço) o servidor MCP e as contas no Composio.
2. **Escrita com confirmação.** Leitura roda direto; escrita segue a autonomia do bot / JEV, como os outros conectores. Rotinas (sem humano) só recebem leituras.
3. **v1:** seção "Composio" em Configurações > Personalização (`?settings=composio`) e card no Marketplace que leva até ela. Na seção: chave (mascarada), busca de apps, conectar, desconectar.
4. **Gatilhos → rotinas:** fora da v1.
5. **Nativo vence.** Se o app existe como conector nativo conectado (GitHub, Gmail, Notion, Slack, Google\*, Firecrawl, Brave), as tools do mesmo toolkit no Composio ficam fora do run. A UI avisa no app.

## Desenho

- **Armazenamento:** uma linha `McpConnection` por usuário com `catalogId = "composio"`. **Sem migration.** A chave, a URL real do servidor MCP (com o `user_id`) e o header `x-api-key` ficam em `secretsEnc` (cofre). A coluna `url` guarda só a URL pública sem credencial. A API nunca devolve a chave, só `••••` + 4 últimos caracteres.
- **`user_id` do Composio:** `HMAC-SHA256(CONNECTOR_ENCRYPTION_KEY, "atlas:composio-user:v1:<userId>")`, truncado (`atlas_<32 hex>`). Estável, não reversível e sempre derivado da sessão, nunca de body/query. Girar a chave do cofre órfã as contas já conectadas (é preciso reconectar).
- **Cliente REST** (`packages/agent-runtime/src/mcp/composio/client.ts`): `fetch` injetável, timeout de 15 s, erros com `redactSecrets`. Operações: listar toolkits, auth config gerenciado, link de conexão, listar/apagar contas, criar/apagar servidor MCP.
- **Servidor MCP por usuário:** recriado a cada conexão/desconexão com os toolkits ativos (sem `allowed_tools`, as tools entram pelo índice diferido `mcp_tool_search`). A URL nova substitui a antiga no cofre; o servidor velho é apagado.
- **Runtime:** nenhuma mudança no loop. A conexão entra no `McpToolset` como qualquer outra. Classificação: anotação MCP quando existe; sem anotação, o primeiro token depois do toolkit decide (`LIST/GET/FETCH/SEARCH/READ/FIND/RETRIEVE/QUERY/VIEW/CHECK/DESCRIBE` = leitura; o resto = escrita, e `SEND/DELETE/...` = irreversível pela regra existente).
- **Rotas** `/v1/composio/*` (todas `requireUser` + `scopeFor`): `status`, `PUT/DELETE key`, `toolkits`, `connect`, `callback`, `connections` (`GET`, `DELETE :id`). Conta de outro usuário nunca aparece na lista do `user_id` do dono, então vira 404. O callback usa `state` de uso único (hash em `oauthStateHash`, TTL 15 min) e confere `connected_account_id` na lista do Composio do próprio usuário. As rotas genéricas `/v1/mcp/*` não listam nem alteram essa linha.
- **Web:** `SettingRow` com ícones, popup reaproveitando `openMcpOAuthPopup`/`waitMcpOAuthPopup`, página de retorno da API no mesmo estilo da do MCP (rodapé "Atlas · Composio"). O link de login só abre se for `https` em `*.composio.dev`.

## Riscos

- **Custódia de tokens de terceiros:** os tokens OAuth dos apps ficam no Composio, não no cofre do Atlas. O usuário confia no Composio; dizer isso na UI/README quando sair da v1.
- **Cota:** o plano gratuito do Composio tem ~100 mil chamadas por mês. Estourar devolve erro do Composio, repassado ao agente como falha de tool (sem sucesso falso).
- **Latência de gatilhos (fase futura):** triggers do Composio por polling têm atraso de minutos; webhooks exigem assinatura verificada antes de qualquer efeito.
- **Anotações não confirmadas:** não está confirmado que `tools/list` do Composio expõe `readOnlyHint`/`destructiveHint`. Por isso a heurística de nome; se faltar anotação, o padrão seguro é escrita (pede confirmação).
- **Endpoints REST:** escritos conforme a documentação (v3.1) sem chave real. Validar com chave real antes de liberar (ver lista abaixo).
- **Nome do servidor MCP, limite de toolkits por servidor e `auth_config` por toolkit** podem ter restrições não documentadas.
- **Meta-tools da Tool Router** (`MULTI_EXECUTE`, `REMOTE_BASH`) ficam de fora: são opacas e quebram a classificação leitura/escrita.

## A validar com chave real

1. `GET /api/v3.1/toolkits` (campos `slug`, `name`, `meta.description`, `next_cursor`, parâmetro `search`).
2. `GET/POST /api/v3.1/auth_configs` (filtro `toolkit_slug`; corpo para auth gerenciado).
3. `POST /api/v3.1/connected_accounts/link` e os parâmetros do retorno (`status`, `connected_account_id`).
4. `GET /api/v3.1/connected_accounts?user_ids=&statuses=ACTIVE` e `DELETE /connected_accounts/:id`.
5. `POST /api/v3.1/mcp` (nome aceito, `toolkits[].auth_config`) e `DELETE /mcp/:id`; URL `https://backend.composio.dev/v3/mcp/<id>?user_id=<uid>` com `x-api-key`.
6. Se `tools/list` traz `annotations`.

## Fora da v1

Gatilhos → rotinas; escolha fina de tools por app (`allowed_tools`); logos dos apps; Composio no onboarding do agente.
