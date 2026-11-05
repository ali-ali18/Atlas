# adapters/

Implementações das portas de `../ports/`. Hoje: `llm/` (porta `Llm` sobre `packages/llm`, com cadeia de reserva) e `random.ts` (CSPRNG).

Virão em itens posteriores do plano: Prisma (`Store`), BullMQ (`Queue`), VM (`Sandbox`) e cofre (`Vault`).

`llm/`: falha antes de qualquer texto troca de entrada na mesma chamada (com `notice`); falha no meio do stream devolve `finishReason: "error"` com o parcial e o kernel refaz o passo (sem emendar dois modelos). Transporte com 1º evento e ociosidade de 120s e sem teto total enquanto houver tokens (o baseline da v2 mostrou cortes em 30s/20s/90s matando passos saudáveis).

Este é o único lugar de `src/` onde `process.env` é permitido (a guarda em `boundary.test.ts` confere); no resto, a configuração chega injetada.
