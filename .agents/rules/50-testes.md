---
description: Testes — o que testar, onde e como rodar
alwaysApply: true
---

# Testes

## O que testar (mínimo por mudança)
- Função pura nova → teste unitário com os limites (vazio, máximo, inválido, fuso/data).
- Bug corrigido → um teste que falhava antes e passa agora (de preferência reproduzindo o caso real do banco).
- Rota ou função de db nova → caminho feliz + **acesso de outro usuário** (ver `40-seguranca.md`).
- Tool do agente nova ou alterada → teste em `computer-use*.test.ts` com LLM mockado: a tool aparece ou não aparece, o executor valida os args e emite os eventos certos.
- Mudança de comportamento do agente → **replay** da conversa real com LLM mockado (padrão: "me lembra dia 03/10 às 10h e 20h").

## Como rodar
```bash
pnpm --filter @workspace/shared test
pnpm --filter @workspace/agent-runtime test
# api e worker (node:test via tsx)
cd apps/api    && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"
cd apps/worker && NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test "src/**/*.test.ts"
pnpm exec turbo typecheck
```
- Mudou `shared`, `db` ou `queue` e o teste de api/worker importa de `dist/`? Rode `pnpm exec tsc` no pacote antes.
- No Windows, `prisma generate` pode dar EPERM (arquivo travado). Pare o processo que usa o client ou rode `tsc`. Não mascare o erro.

## Regras
- Não apague nem pule (`.skip`) teste para ficar verde. Teste quebrado por mudança legítima → atualize e explique no commit.
- Nada de rede real, OpenRouter ou Google em teste unitário. Use `fetch`, `GoogleFetchFn` ou `streamChat` mockados.
- Datas: injete `now`. Nunca dependa do relógio real (ex.: "próximo 03/10" calculado a partir de `now`).
