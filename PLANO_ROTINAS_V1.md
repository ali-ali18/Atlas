# Rotinas v1

Rotina = prompt salvo + gatilho cron + execução sem o usuário online.
Persistir no Postgres, disparar via BullMQ, reusar `createAgentRun` / `run-agent` com `origin: "routine"`.
Não reinventar o agent loop. Não deixar rotina só no React. Não refatorar `packages/agent-runtime`.

## Princípios

1. Definição da rotina = DB (sobrevive restart).
2. Execução = `AgentRun` (mesmo runtime de chat).
3. Prompt = intenção (“checa X e resume”), não lista rígida de tools.
4. UI só CRUD + status; scheduler é backend.
5. Silêncio permitido: se o agente não tiver o que reportar, o run termina sem ping.

## Contrato

- `Routine`: `prompt`, `enabled`, `triggerType` (`cron` | `event`), `schedule` (cron 5 campos), `timezone`, `model`, `triggerJson`, `lastRunAt`.
- `RoutineRun`: `queued | running | succeeded | failed | skipped`, `triggeredBy` (`schedule | manual | event`), `summary`, `eventJson` (webhook).
- Repeatable BullMQ `key = routine:{id}` **só para cron**. `syncRoutineScheduler` ignora `event`.
- Overlap: se já há run `queued|running` da rotina → `skipped`.
- `AgentRun.origin` = sempre `"routine"` (também no webhook). **Não** usar `origin: "webhook"`.
- Chat: prompt da rotina não vira bolha de user; resultado do agente aparece.
- Webhook: `POST /v1/hooks/:hookKey` + `X-Atlas-Hook-Secret`. Match por `triggerJson.hookKey` (sem coluna denormalizada).

### Env

- `ATLAS_PUBLIC_URL` — base da URL do hook (ex. `http://127.0.0.1:3001`)
- `ATLAS_HOOK_PEPPER` — pepper do hash do secret

### Exemplo curl

```bash
curl -X POST "$ATLAS_PUBLIC_URL/v1/hooks/HOOK_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Atlas-Hook-Secret: SECRET" \
  -d '{"ping":true}'
```

GitHub tipado depois: `normalizeGithub` + rota `/v1/webhooks/github` + reusar `dispatch`.

## Aceite

- Criar “todo dia 9:00”, F5, ainda existe.
- Worker dispara, cria AgentRun, aparece no histórico.
- Pause para de enfileirar; run-now funciona.
- Restart API/worker: repeatables voltam do DB.
- Segundo disparo com run ativo vira `skipped`.
