# `@workspace/agent` — motor v4 do Atlas

O motor do agente do Atlas, feito para o Atlas e open-source junto com ele (MIT). Não é uma biblioteca genérica para outros produtos. É uma base nova: não importa nada de `@workspace/agent-runtime` (v1/v2/v3), para que o legado possa ser apagado no fim. O plano está em `PLANO-AGENTE-V4/`.

## Estado atual (honesto)

Prontos: as **portas** e as guardas (F1.1); na F1.2, as **classes de efeito**, o `defineTool` e as **capacidades** (registro, índice, `use_capability`, ganchos tipados); na F1.4 a F1.6, o **executor do contrato** (`createExecutor`); e, na F1.7, os **canais** (nonce por run, envelopes e escape). O resto abaixo é o desenho, ainda sem código.

| Camada | O que é | Existe? |
|---|---|---|
| `ports/` | interfaces `Llm`, `Store`, `Queue`, `Sandbox`, `Vault`, `Clock`, `Events` | sim |
| `adapters/` | implementações das portas (Prisma, BullMQ, VM, cofre, `packages/llm`) | pasta, sem código |
| `kernel/` | laço, estado do run, checkpoint, compactação | não |
| `contract/` | classes de efeito (`effects.ts`); `executor.ts` (único caminho de toda chamada: efeito → `authorize()` → aprovação → execução); `approval.ts` (cartão por `riskFacts`, token = hash dos argumentos, uso único); `provenance.ts` (taint de fonte não confiável); journal de efeitos e recibos obrigatórios; redação de segredo | sim (a política pura `decide`/mandato mora em `shared`; falta handoff de superfície e o laço que chama o executor) |
| `tools/` | `defineTool`: efeito obrigatório, args validados pelo zod, resultado `ok`/`erro` tipado, `LlmToolSpec` | sim |
| `channels/` | envelopes: fala do usuário (limpa), sistema (`<atlas:runtime id=nonce>`), dado não confiável (`<data … trust="untrusted">`), escape determinístico, parágrafo de canais do prompt estável. O nonce vai no `[context]`, não no prompt estável (cache) | sim |
| `capabilities/` | `defineCapability`, registro, índice de uma linha, carga só de acréscimo (`use_capability`), ganchos tipados. Uma pasta por feature virá nas fases seguintes | sim (o mecanismo; sem capacidades concretas) |
| `agenda/` | lembrete, vigia, intenção por evento | não |
| `memory/` | perfil, caderno, sessões | não |
| `presets/` | `full` e `minimal` | não |

Tudo de fora entra por porta injetada: o worker monta as implementações reais, o teste monta mocks. Lógica pura compartilhada com o legado vai para `packages/shared`.

## Contrato: como uma chamada de tool passa

`executor.executeCall({ callId, step, tool, args, grant? })` devolve um `CallOutcome`:

1. A tool dá a classe de efeito e os `riskFacts` dos argumentos; o `authorize()` chama `decide()` só com metadado (sem campo de conteúdo, o tipo impede).
2. `handoff` e `hidden` não rodam e devolvem texto honesto ao modelo e ao dono (`handoff`, `not_available`).
3. `approve` devolve `pending_approval` com o cartão (argumentos sem segredo + `riskFacts`). Só roda com `ApprovalGrant` do hash atual dos argumentos, uso único; mudou um argumento, `approval_invalid`. O modelo não produz o grant.
4. Efeito (qualquer classe, menos `read`) grava `started` no journal (chave `runId:callId:hash`) antes e `succeeded`/`failed` depois. Na retomada, `started` sem fim vira `interrupted_write`, e `succeeded` vira `already_done`: nunca repete às cegas.
5. Efeito sem recibo é `contract_error`. O recibo vai para `Store.receipts`.
6. Tool `trust: "untrusted"` marca o run (`RunProvenance`); trecho de 24+ caracteres copiado dela para os argumentos também marca a chamada. Os dois booleanos entram no `decide()`.
7. Erro e resumo passam por `redactSecrets` antes de chegar ao modelo.

## Regras

- **Sem regex em decisão de comportamento.** Parar, promover, entregar ou barrar usa sinal estrutural (estado do run, tools chamadas, campo declarado numa tool), nunca regex sobre texto do usuário ou do modelo.
- **A resposta do modelo nunca é reescrita, descartada nem substituída.**
- **Sem corte de contexto por economia.** Compactação só com a janela quase cheia e de forma restaurável; leitura em partes no lugar de truncar. O único teto de gasto é o que o dono configurar.
- **Toda tool declara uma classe de efeito** (`read`, `draft`, `write_internal`, `write_external`, `send`, `money`, `public_link`, `credential`, `destructive`); a política é a mesma em todas as superfícies.
- **Segredo nunca no contexto do modelo**: só a porta `Vault`, na camada de execução.
- **Nada do dono no código**: sem chave, e-mail, conta ou dado pessoal; exemplos genéricos e trocáveis. A guarda de higiene confere.
- **`process.env` só em `src/adapters/`.**

## Testes

```bash
pnpm --filter @workspace/agent test
pnpm --filter @workspace/agent typecheck
```

- `src/boundary.test.ts`: falha se algo importar `@workspace/agent-runtime` (ou caminho relativo para ele) ou usar `process.env` fora de `adapters/`.
- `src/hygiene.test.ts`: falha se o pacote tiver cara de chave de API, e-mail real ou nome da denylist.
