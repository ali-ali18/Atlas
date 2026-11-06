# adapters/

Implementações das portas de `../ports/`. Hoje: `llm/` (porta `Llm` sobre `packages/llm`, com cadeia de reserva) e `random.ts` (CSPRNG).

F1.12 (todos recebem a dependência real por INJEÇÃO; este pacote não importa Prisma, BullMQ nem o agent-runtime):
- `store.ts`: `Store` completo (runs/journal/receipts/agenda/notes/conversations) sobre funções `StoreBackend`; o worker liga as de `@workspace/db` (`agent-v4-store`). Agenda ainda sem tabela: escrever falha com mensagem honesta.
- `queue.ts`: `Queue` sobre uma fila com a forma do BullMQ (`add`/`getJob`); id de job estável por (dono, chave) e `cancel` só do próprio dono.
- `events.ts`: entrega ao `persist` os eventos JÁ mapeados para o contrato SSE (`ComputerUseEvent`), em ordem; o mapeamento é do kernel (`sse-map`) e entra por `map`.
- `vault.ts`: `Vault` sobre o serviço de cofre; o valor só sai por `reveal()` e não vira texto em JSON/console.
- `clock.ts`: relógio do sistema.

Virá em item posterior: VM (`Sandbox`).

`llm/`: falha antes de qualquer texto troca de entrada na mesma chamada (com `notice`); falha no meio do stream devolve `finishReason: "error"` com o parcial e o kernel refaz o passo (sem emendar dois modelos). Transporte com 1º evento e ociosidade de 120s e sem teto total enquanto houver tokens (o baseline da v2 mostrou cortes em 30s/20s/90s matando passos saudáveis).

Este é o único lugar de `src/` onde `process.env` é permitido (a guarda em `boundary.test.ts` confere); no resto, a configuração chega injetada.
