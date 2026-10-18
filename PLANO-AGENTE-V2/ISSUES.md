# Issues abertos (fora das fases)

Formato: `### I<n> — <título>` · status · dono sugerido · sintoma · hipóteses · como verificar · critério de aceite.

### I1 — Streaming não chega em tempo real: várias mensagens aparecem de uma vez
**Status:** aberto (29/09) · **Dono sugerido:** Bot B (runtime/SSE), com a parte web
**Sintoma (usuário):** durante o run, nada aparece; depois chegam várias mensagens juntas (ex.: 6 ao mesmo tempo). A sensação é de que o stream não funciona.

**Contexto:** desde a auth (Fase 3 do `AUTH_PLAN`), o browser só fala com o web (`:3000`). O Next faz rewrite de `/v1/*` para a API (`apps/web/next.config.ts`). O comentário ali diz que o rewrite repassa o SSE sem buffer, e a API manda `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` (`apps/api/src/routes/chat.ts`, `computer.ts`, `runs.ts`). Isso **não foi medido** com um run real depois do merge da auth.

**Hipóteses (em ordem):**
1. **O proxy do rewrite do Next faz buffer** (principalmente no `next dev`) ou comprime a resposta, apesar do `no-transform`. O SSE só é descarregado no fim.
2. **O cliente não está no stream:** `use-atlas-chat.ts`/`lib/atlas-api.ts` pode ter caído no caminho de polling (`/runs?active=1`, eventos por `listRunEventsAfter`) ou reconectado com um `Last-Event-ID` que faz replay em lote. As mensagens chegam juntas no poll seguinte.
3. **O servidor só grava/emite no fim do passo:** o texto do modelo é salvo por passo (`onStep`) e os eventos intermediários (texto que acompanha tool calls) não são emitidos como `delta` durante o passo. Aí vários passos terminam juntos e aparecem em sequência.
4. **Heartbeat/flush:** a primeira escrita do stream não sai até encher um chunk (sem comentário `:` inicial nem flush), e proxies seguram.

**Como verificar:**
- `curl -N -H "Cookie: <sessão>" http://localhost:3000/v1/runs/<id>/stream` **vs** `curl -N ... http://127.0.0.1:3001/v1/runs/<id>/stream` durante um run longo. Se a API direta (`:3001`) chega aos poucos e o `:3000` chega em lote, é a hipótese 1.
- DevTools → Network no web: a requisição do stream existe e fica aberta (EventStream/`text/event-stream`), ou só aparecem polls?
- Timestamps dos `run_events` do run (`createdAt`): espalhados ao longo do run (servidor ok) ou juntos no fim (hipótese 3)?

**Correções possíveis (conforme a causa):**
- (1) Stream **direto na API** para `/v1/runs/:id/stream`: um route handler do Next que faz pipe com `ReadableStream`, ou roteamento por caminho no Traefik/Dokploy em produção. Em dev, testar `compress: false` só para confirmar.
- (2) Corrigir o cliente para abrir o SSE e fazer replay incremental.
- (3) Emitir `delta` de texto e eventos de tool durante o passo.
- (4) Comentário inicial `: ok\n\n` + heartbeat a cada ~15 s.

**Critério de aceite:** num run com 6+ passos, cada mensagem ou tool aparece no chat em até ~1 s depois de o servidor emitir, tanto pelo `:3000` (via rewrite) quanto em produção. Teste: um teste de integração do handler SSE (chunks chegam antes do fim) + a medição manual com `curl -N`.
