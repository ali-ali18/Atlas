# adapters/

Implementações das portas de `../ports/`. **Ainda não há código aqui.**

Virão em itens posteriores do plano: Prisma (`Store`), BullMQ (`Queue`), VM (`Sandbox`), cofre (`Vault`) e `packages/llm` (`Llm`, com a cadeia de reserva).

Este é o único lugar de `src/` onde `process.env` é permitido (a guarda em `boundary.test.ts` confere); no resto, a configuração chega injetada.
