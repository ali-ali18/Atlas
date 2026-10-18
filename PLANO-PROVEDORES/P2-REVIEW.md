# P2 — revisão

Base 4fe6e44; branch agente-v3/gpt-p2. Plano congelado, sem push/merge.

Exceção OAuth deliberada: GET /callback somente em listener loopback dedicado,
fora de /v1 e da API principal. Cookie Atlas não atravessa localhost → 127.0.0.1.
Autenticação por state imprevisível com hash, uso único e TTL, ligado ao dono,
PKCE S256 e id_token assinado (issuer/audience/nonce/exp). Nenhuma allowlist /v1 alterada.

Migração ProviderConnection apenas gerada em arquivo: NÃO aplicada no banco real.
Claude deve fazer backup e aplicar depois da revisão.

## Entrega e contratos

- `@workspace/agent-runtime`: `createChatgptAuthService(deps?)` e `chatgptAuthService`.
- `status(userId)` → `{provider,status,accountEmail,updatedAt,lastLimitAt}` sem segredo.
- `connect(userId)` → `{authorizeUrl}`. Cliente abre popup, nunca recebe verifier/token.
- `getAccessToken(userId,{force?,previousAccessToken?})`: escopo real do dono vindo do run.
- `markNeedsLogin(userId)`: limpeza fatal preservando host/client/subject.
- `disconnect(userId)` → `{revocationConfirmed:boolean}`; DELETE expõe só esse metadado.
  Se false, UI orienta revogação em Configurações do ChatGPT (P5); não promete revogação remota.
- DB: `getProviderConnection`, `updateProviderConnection`, `withProviderRefreshLock` e tipos;
  lock `provider-refresh:<userId>:<provider>` parametrizado, mesmo namespace em login/disconnect/refresh.
- Callback claim comita hash consumido e client emitido ANTES da troca de código;
  nonce retido no cofre identifica geração e impede sobrescrever disconnect/reconnect em voo.
- Refresh fatals são sentinel retornado da transação, commit da limpeza, depois throw.
  HTTP 2xx com corpo perdido/inválido é fatal porque o servidor pode já ter rotacionado.
- `SiwcAuthError` contém apenas código permitido e mensagem fixa; nenhum corpo remoto.
- JWKS RS256 no issuer fixo, sem jku/x5u; issuer/aud/azp/nonce/sub/exp/nbf validados.
- Todos fetches de credenciais usam `redirect:error`, timeouts e endpoints oficiais.

## Commits (novos, ordem)

fdc3312 refactor(auth): compartilhe o cofre sem alterar envelopes MCP

d09ddfb feat(db): isole conexões de provedor e serialize refresh por dono

964196e feat(auth): valide tokens SIWC com assinatura e claims OIDC

a757fe0 feat(auth): renove SIWC com lock e refresh rotativo persistido

3dabacf feat(auth): conecte ChatGPT por SIWC oficial no cofre do dono

8f39172 feat(api): exponha SIWC ao dono com callback loopback dedicado

f4a1850 fix(auth): informe se a revogação remota SIWC foi confirmada

d2f16ea perf(auth): use access token válido sem disputar lock de refresh

63eeaac fix(auth): consuma callback antes da rede e preserve logins novos

e185bae fix(auth): bloqueie redirects no transporte de credenciais SIWC

31aec40 fix(auth): exija login se perder o corpo após refresh aceito

## Verificação real sem rede OAuth, sem banco real

`pnpm --filter @workspace/agent-runtime test` (HEAD 31aec40):

```text
Test Files  81 passed | 1 skipped (82)
Tests  778 passed | 10 skipped (788)
Duration  7.14s
```

API: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`:

```text
tests 130
pass 130
fail 0
skipped 0
duration_ms 10797.5732
```

DB (executado com tsx da API):
`pnpm exec tsx --test "../../packages/db/src/*.test.ts"`:

```text
tests 67
pass 67
fail 0
skipped 0
duration_ms 2827.6996
```

Worker: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"`:

```text
tests 68
pass 68
fail 0
skipped 0
duration_ms 8532.5106
```

`pnpm exec turbo typecheck`: todas as 12 tarefas aprovadas.
`git diff --check`: limpo.
Prisma generate e tsc só no client isolado deste worktree, nenhum migrate/deploy/push.

## Limitações e itens de integração

- NÃO aplicar `20261004160000_provider_connections` sem backup do Claude.
- Corrida entre processos simulada por duas instâncias + store serializado;
  SQL de advisory lock verificado com fake Prisma. Sem duas conexões PostgreSQL reais.
- Sem OAuth, JWKS, refresh ou revogação reais nos testes; fixtures sintetizadas no formato do spike.
- Listener testado pela função handler (sem bind TCP real). Docker exige publicação loopback
  manual documentada no env; compose não foi tocado conforme escopo.
- Navegador e API devem estar na mesma máquina; hospedagem remota fora do escopo.
- 401 de inferência/repetição única pertence ao adaptador P1; P2 expõe force/previousAccessToken
  e markNeedsLogin e testa a corrida que poderia devolver o token inválido em voo.
- P3 monta catálogo no próprio arquivo providers; P4 injeta o serviço usando dono do run;
  P5 exibe alerta quando revocationConfirmed=false.
- Sem push, sem merge, nenhuma credencial do spike/Codex lida.

Fontes oficiais verificadas:
[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
e [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
