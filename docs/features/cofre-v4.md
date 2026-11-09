# Cofre no motor v4

- **Status:** entregue (F9, branch `feat/f9-cofre`)
- **Data:** 2026-11-09
- **Issues/PRs:** F9 (capacidades do legado que faltam no v4)

## O que é
O bot usa os segredos e os logins do cofre do dono sem nunca ver o valor: lista os nomes, pede ao dono o que falta, entra num site com o login salvo e usa uma chave dentro de uma chamada de conector, tudo com o valor escondido.

## Problema
No legado o cofre vivia em `agent-runtime` (`vault-tools.ts`, `secrets/*`). O motor v4 tinha só a porta `Vault` (sem tool nenhuma), então o bot novo não conseguia entrar num site, pedir uma chave nem usar um segredo.

## Por que existe
Decisão do dono: toda capacidade do legado vem para o v4 com o contrato novo ("segredo nunca entra no contexto do modelo"), em capacidade lazy (o "Bom dia" continua pequeno).

## Alternativas descartadas
- Importar o `VaultService` do `agent-runtime` no adaptador: proibido pela fronteira do pacote. A cripto pura (caixa de segredos, envelope por usuário, TOTP) foi movida para `@workspace/db/vault-crypto`; o legado reexporta dali.
- Rota nova no control server para o login: a rota `/browser/type` já confere campo e origem; foi reaproveitada.
- Aprovação por conversa/"sempre para este bot" do legado: o v4 usa o cartão de aprovação de efeito `credential` a cada uso (decisão da frente).

## Como funciona
Capacidade `vault` (`packages/agent/src/capabilities/vault/`), lazy:

| Tool | Efeito | Regra |
|---|---|---|
| `secret_list` | `read` | Só nomes, tipo, descrição, site e, nos logins, as chaves e rótulos dos campos (e se são secretos); o `username` só no login antigo. Nunca valor. Vale também sem dono. |
| `secret_request` | `read`, encerra o turno | Duas formas. Segredo simples (`names`): cartão "Salvar no cofre" com campo de senha. Login (`kind: "login"`, `site`, `fields: [{ key, label, secret }]`): um campo por item que o MODELO declarou olhando a página (ver "Login de campos decididos pela IA"). É o mesmo `confirm` + `secretsRequest` do legado (web e API tratam). Só com dono e conversa. O que já existe não gera cartão. |
| `login_fill` | `credential` | Cartão de aprovação a cada uso, em qualquer autonomia; sem dono a tool fica fora. Leva à VM só o NOME do login (opcional) e o mapeamento `fields: [{ key, ref }]` (campo salvo -> campo da página, ref do `browser_map`); `kind` `vault.login_fill`, ver `capabilities/vault/kinds.ts`. Sem nome, o login é achado pelo site da página atual (abaixo). |

### Login de campos decididos pela IA (F9, decisão do dono 09/11)
O login deixou de ser só usuário + senha: quem olha a página declara os campos.
- **Declarar.** O modelo abre a página (`browser_open`/`browser_map`) e chama `secret_request` com `kind: "login"`, `site` e um `{ key, label, secret }` por entrada da tela (`email`; `nome`, `cpf`, `senha`; `usuario`, `senha`). `key` segue o formato de nome do cofre; `label` é o que o dono lê; `secret` diz se é senha/código (campo de senha) ou não (campo de texto). Até 8 campos; chave repetida, rótulo vazio, `secret` ausente ou propriedade desconhecida falham com o aceito.
- **Um cartão por etapa.** Tudo na mesma página = um cartão com todos os campos. Login em etapas (ChatGPT: e-mail, depois senha) = um cartão por etapa, só com os campos daquela etapa; a tool pede apenas os que ainda não estão salvos.
- **Um item só.** A rota `POST /v1/vault/logins` (cartão da web) grava os campos NUM item de login do site: acha o item existente por nome (login sem site ou do mesmo site) ou pelo site normalizado (`siteKey`: sem `www.`, esquema, caminho nem query) e ACRESCENTA os campos (mesma chave troca o valor; nada é apagado). Sem item, cria um com o nome do site (sufixo `-2` se o nome já é de outro item). Nunca um segredo solto por campo.
- **Onde fica.** Os valores e a declaração ficam dentro do envelope cifrado (`valueEnc` -> `fields: [{ key, label, secret, value }]`), sem migration. A lista do modelo lê só a declaração (o worker abre o envelope para isso; o valor nunca sai). O `username` em claro só existe nos logins antigos.
- **Compatibilidade.** Login antigo (`username` em claro + `password` cifrada) é lido como os campos `username` (não secreto) e `password` (secreto), sem migrar. Campos novos podem ser acrescentados a ele. A tela Configurações > Cofre continua editando usuário/senha; os campos novos ficam fora dela (ver Pendências).
- **Preencher.** `login_fill` leva `fields: [{ key, ref }]`. O tratador confere (https, site exato, reconferir a aba antes de CADA campo, aprovação a cada uso, sem dono a tool não existe), recusa ANTES de digitar se uma chave não é do login (o erro lista só as chaves salvas) e digita cada valor pela rota `/browser/type` do control server, agora por `ref`. A VM trava: documento principal (sem iframe), campo visível, entrada de texto ou senha, formulário que só envia para a própria origem, origem da aba igual à do site salvo. A `password` do login antigo só entra em input de senha (trava `password`); os demais campos usam a trava nova `field`. O valor só trafega worker -> VM.

- **Tratador no worker** (`apps/worker/src/v4-adapters/sandbox-vault-login.ts`): lê do cofre só os campos mapeados, confere que a página atual é o site salvo do login (https, host exato) antes de CADA campo, e digita pela rota `/browser/type` do control server (que ainda valida o campo e a origem). O resultado traz só as chaves preenchidas, o site e o domínio de chegada. Login sem site salvo nunca é digitado (o dono salva o site em Configurações, Cofre; o cartão de vínculo do legado fica de fora). O código 2FA nunca é digitado pelo bot.
- **Achar o login pelo site** (`login_fill` sem `login`): o modelo às vezes não acerta o nome do item mesmo estando no site certo. Sem nome, o tratador lê a URL da página atual e compara com o site salvo de cada login do dono, os dois normalizados do mesmo jeito (`siteKey` em `packages/shared/src/vault.ts`: minúsculas, sem `www.`, sem ponto final; esquema, caminho, query, hash e barra final não contam; porta só em localhost e IP). Exatamente 1 candidato: usa. 0: erro honesto que lista só nome e site dos logins de site parecido (mesmo domínio registrável, ex.: `painel.banco.example`); 2 ou mais: erro que lista os candidatos e pede para chamar de novo com o nome. A checagem de segurança é a mesma depois de escolher o login (https, host igual, reconferir antes de CADA campo; login sem site nunca casa). O cartão de aprovação sem nome diz "o login salvo para o site da página atual" (a tool não sabe qual é antes da VM olhar a página). O resultado traz o nome do login usado, nunca valor.
- **Adaptador** (`apps/worker/src/v4-adapters/vault.ts`): porta `Vault` sobre `@workspace/db` + `@workspace/db/vault-crypto`. `resolve` só entrega segredo simples do dono (senha de login nunca por aqui) e audita o uso; item de outro dono é igual a inexistente.
- **`{{secret:NOME}}` no executor**: tool que declara `acceptsSecretRefs` (hoje `code_shell` e as tools `mcp_*` dos conectores PRIVADOS do dono) recebe o valor na hora de executar. Os nomes são conferidos antes do cartão (sem ler valor); o valor só é lido depois da aprovação; cartão, hash do journal e eventos ficam com o marcador; o cofre rastreado do run (`trackVault`) faz toda saída sair com `[redacted]`. `{{login:...}}` e `{{secret:rotina:...}}` são recusados com a dica do `login_fill`.
- Sem dono (`unattended`, agenda): a capacidade entra só com `secret_list`.
- **Rotina com permissão de login (F9 parte 2, decisão do dono 09/11):** o dono aprova no cartão da criação ou edição da rotina "usar o login X para entrar em Y nesta rotina" (`routine_create`/`routine_update` com `loginAccess`, efeito `credential`); a rotina guarda `{ login, site normalizado }`. No run da rotina (sem dono) o registro ganha um `login_fill` só para aquele login e aquele site (`routine-login-fill.ts`; efeito `write_internal`, a aprovação foi a da criação). A ação leva `onlySite` e o tratador só digita se a página bater com o site aprovado, reconferindo antes de CADA campo, além das checagens de sempre. Sem permissão, a rotina só tem `secret_list` e a instrução manda dizer no resultado que não entrou. Ver `rotinas-v4.md`.

## Riscos
- Trava `field` da VM (campos de login por ref): vale para qualquer entrada de texto visível do documento principal, não só input de senha. O modelo escolhe o ref; quem protege é o conjunto site exato + https + origem + formulário na própria origem + aprovação do dono a cada uso. Um modelo induzido por injeção poderia apontar um campo de busca do MESMO site; o valor não sai do site salvo.
- Deploy com api e worker em versões diferentes: cartão de login só existe com os dois novos; `login_fill` antigo (`fields` como lista de strings) é recusado pelo schema novo. Sem migration; dado antigo segue legível.
- Vazamento do valor: coberto por testes de que pedidos ao modelo, eventos, journal, recibos e checkpoint não têm o valor (`vault-capability.test.ts`, `contract-invariants.test.ts` D), e de que erros da VM passam por `redactSecrets` com os valores lidos.
- Exfiltração por prompt injection: marcador não vale em conector público (busca), só nos privados; `code_shell` fora da allowlist pede aprovação mostrando o comando com o marcador.
- Phishing: a senha só é digitada no site salvo; a VM ainda confere origem e campo.
- Linhas do cofre: nenhuma migration; o campo novo `fields` vive dentro do envelope. O motor legado ignora `fields` (só entende `password`): logins de campos declarados são do v4.
- `secret_request` usa a intenção pendente da conversa (uma por vez), como no legado.

## Custo
Só uma linha do índice no prompt (teste de economia: "Bom dia" não ganha tool nem regra do cofre). Sem chamada extra ao modelo.

## Pendências (fora desta frente)
- Tela Configurações > Cofre ainda não lista nem edita os campos declarados pela IA (mostra o login como usuário/senha); o dono vê e apaga o item, e pode refazer os campos pelo bot.
- Cartão do celular: segue como "ver no web" (como os demais cartões de cofre).
- `routine_webhook_info` entrou com as rotinas (só o endereço, nunca o segredo). O marcador `{{secret:rotina:...}}` (ligar outro sistema por conector sem colar o segredo) continua recusado pelo executor: fica para uma frente do cofre.
- Vínculo de login sem site por cartão, login automático do navegador (`tryAutoVaultLogin`) e aprovação "sempre para este bot".
- `{{secret:...}}` em outras tools de saída (ex.: `code_write`/`code_edit`) e em conector público: não habilitado de propósito.

## Como testar
```bash
pnpm --filter @workspace/agent test
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/v4-adapters/*.test.ts" src/engine-v4.test.ts
```
