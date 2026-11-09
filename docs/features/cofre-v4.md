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
| `secret_list` | `read` | Só nomes, tipo, descrição, site e usuário. Nunca valor. Vale também sem dono. |
| `secret_request` | `read`, encerra o turno | Cartão "Salvar no cofre" com campo de senha (o mesmo `confirm` + `secretsRequest` do legado: web, celular e API já tratam). Só com dono e conversa. O que já existe não gera cartão. |
| `login_fill` | `credential` | Cartão de aprovação a cada uso, em qualquer autonomia; sem dono a tool fica fora. Leva só o NOME do login à VM (`kind` `vault.login_fill`, ver `capabilities/vault/kinds.ts`). |

- **Tratador no worker** (`apps/worker/src/v4-adapters/sandbox-vault-login.ts`): lê usuário e senha do cofre, confere que a página atual é o site salvo do login (https, host exato) antes de CADA campo, e digita pela rota `/browser/type` do control server (que ainda valida o campo e a origem). O resultado traz só os campos preenchidos, o site e o domínio de chegada. Login sem site salvo nunca é digitado (o dono salva o site em Configurações, Cofre; o cartão de vínculo do legado fica de fora). O código 2FA nunca é digitado pelo bot.
- **Adaptador** (`apps/worker/src/v4-adapters/vault.ts`): porta `Vault` sobre `@workspace/db` + `@workspace/db/vault-crypto`. `resolve` só entrega segredo simples do dono (senha de login nunca por aqui) e audita o uso; item de outro dono é igual a inexistente.
- **`{{secret:NOME}}` no executor**: tool que declara `acceptsSecretRefs` (hoje `code_shell` e as tools `mcp_*` dos conectores PRIVADOS do dono) recebe o valor na hora de executar. Os nomes são conferidos antes do cartão (sem ler valor); o valor só é lido depois da aprovação; cartão, hash do journal e eventos ficam com o marcador; o cofre rastreado do run (`trackVault`) faz toda saída sair com `[redacted]`. `{{login:...}}` e `{{secret:rotina:...}}` são recusados com a dica do `login_fill`.
- Sem dono (`unattended`, agenda): a capacidade entra só com `secret_list`.

## Riscos
- Vazamento do valor: coberto por testes de que pedidos ao modelo, eventos, journal, recibos e checkpoint não têm o valor (`vault-capability.test.ts`, `contract-invariants.test.ts` D), e de que erros da VM passam por `redactSecrets` com os valores lidos.
- Exfiltração por prompt injection: marcador não vale em conector público (busca), só nos privados; `code_shell` fora da allowlist pede aprovação mostrando o comando com o marcador.
- Phishing: a senha só é digitada no site salvo; a VM ainda confere origem e campo.
- Deploy com versões mistas: nenhuma migration; o formato das linhas do cofre não mudou (legado e v4 leem as mesmas).
- `secret_request` usa a intenção pendente da conversa (uma por vez), como no legado.

## Custo
Só uma linha do índice no prompt (teste de economia: "Bom dia" não ganha tool nem regra do cofre). Sem chamada extra ao modelo.

## Pendências (fora desta frente)
- `routine_webhook_info` e `{{secret:rotina:...}}`: dependem das rotinas, que vêm em outra frente.
- Vínculo de login sem site por cartão, login automático do navegador (`tryAutoVaultLogin`) e aprovação "sempre para este bot".
- `{{secret:...}}` em outras tools de saída (ex.: `code_write`/`code_edit`) e em conector público: não habilitado de propósito.

## Como testar
```bash
pnpm --filter @workspace/agent test
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/v4-adapters/*.test.ts" src/engine-v4.test.ts
```
