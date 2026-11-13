# `@workspace/agent` — motor v4 do Atlas

O motor do agente do Atlas, feito para o Atlas e open-source junto com ele (MIT). Não é uma biblioteca genérica para outros produtos. É uma base nova: não importa nada de `@workspace/agent-runtime` (v1/v2/v3), para que o legado possa ser apagado no fim. O plano está em `PLANO-AGENTE-V4/`.

## Estado atual (honesto)

Prontos: as **portas** e as guardas (F1.1); na F1.2, as **classes de efeito**, o `defineTool` e as **capacidades** (registro, índice, `use_capability`, ganchos tipados); na F1.4 a F1.6, o **executor do contrato** (`createExecutor`); na F1.7, os **canais** (nonce por run, envelopes e escape); na F1.8, o **kernel** (`runAgent`); e, na F1.8b/F1.9, a compactação restaurável, a leitura em partes e o ciclo de vida da tarefa. O resto abaixo é o desenho, ainda sem código.

| Camada | O que é | Existe? |
|---|---|---|
| `ports/` | interfaces `Llm`, `Store`, `Queue`, `Sandbox`, `Vault`, `Clock`, `Events` | sim |
| `adapters/` | implementações das portas (Prisma, BullMQ, VM, cofre, `packages/llm`) | pasta, sem código |
| `kernel/` | `runAgent`: laço burro com estados `PREPARE → MODEL → TOOLS → SETTLE → (PARKED \| FINAL \| DONE)`, checkpoint por passo (com proveniência e capacidades), limites do dono, guarda de laço | sim |
| `contract/` | classes de efeito (`effects.ts`); `executor.ts` (único caminho de toda chamada: efeito → `authorize()` → aprovação → execução); `approval.ts` (cartão por `riskFacts`, token = hash dos argumentos, uso único); `provenance.ts` (taint de fonte não confiável); journal de efeitos e recibos obrigatórios; redação de segredo | sim (a política pura `decide`/mandato mora em `shared`; falta handoff de superfície e o laço que chama o executor) |
| `tools/` | `defineTool`: efeito obrigatório, args validados pelo zod, resultado `ok`/`erro` tipado, `LlmToolSpec` | sim |
| `channels/` | envelopes: fala do usuário (limpa), sistema (`<atlas:runtime id=nonce>`), dado não confiável (`<data … trust="untrusted">`), escape determinístico, parágrafo de canais do prompt estável. O nonce vai no `[context]`, não no prompt estável (cache) | sim |
| `capabilities/` | `defineCapability` (com `instructions` lazy, devolvidas no `use_capability`), registro, índice de uma linha, carga só de acréscimo, ganchos tipados | sim |
| `capabilities-builtin/` | uma pasta por feature: `deliverables` (F2.3: `create_file`, `create_page`, `chart`, `inspect_file` + moldes ABNT/relatório/deck/planilha lazy; portas em `ports/deliverables.ts`, sem ligar no worker ainda) | parcial |
| `agenda/` | lembrete, vigia, intenção por evento | não |
| `memory/` | perfil, caderno, sessões | não |
| `prompt/` | contrato de trabalho do prompt estável (`WORK_CONTRACT_PROMPT`) e `buildStablePrompt(registry)`: contrato, canais e índice de capacidades, ordem fixa, sem data nem nonce; o kernel usa quando o run não traz `stableSystem` | sim |
| `copy/` | textos que o dono lê gerados pelo motor (`copyFor(idioma, id)`), por idioma do bot (`BotLanguage` de `shared`); idioma ausente ou desconhecido cai em `COPY_FALLBACK_LANGUAGE` (pt-BR) | sim |
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
- `src/prompt/work-contract.test.ts`: uma asserção por seção do contrato, orçamento de tamanho (cresceu mais de 15% sobre a linha de base medida, falha; suba a constante com o motivo), higiene e montagem determinística.
- `src/copy/copy.test.ts`: todo id em todos os idiomas, nenhum texto com nome interno (snake_case, campo, id).
- `src/hygiene.test.ts`: falha se o pacote tiver cara de chave de API, e-mail real ou nome da denylist.

## Kernel: como o laço anda

`runAgent({ runId, ownerId, input, ports, registry, policy, limits, hash })` devolve um `RunResult` (`done | not_done | parked | failed`).

- **Estados** (serializáveis, em `Store.runs.saveCheckpoint`): `PREPARE → MODEL → TOOLS → SETTLE → PREPARE …`; `TOOLS` pode estacionar em `PARKED` (aprovação ou handoff; a retomada com `input.resume` volta a `TOOLS`); um limite leva a `FINAL` (um passo de resposta) e tudo termina em `DONE`. O checkpoint leva as mensagens, o passo, as capacidades carregadas, o `RunProvenance.snapshot()` (o taint sobrevive à retomada), gasto, guarda de laço e as chamadas pendentes. Rodar de novo com o mesmo `runId` retoma; o journal do executor impede repetir efeito.
- **Sem empurrão de comportamento.** Resposta sem tool encerra o turno, mesmo "vou fazer X". Só há retries de transporte: `length` → uma continuação; erro do provedor → um retry; resposta vazia → um retry e, se continuar vazia, evento `status` com o motivo real. O texto do modelo passa byte a byte (teste), nunca é trocado nem descartado.
- **Tools** só pelo executor do contrato: leituras em paralelo, o resto em série e na ordem; o resultado volta como mensagem do canal de dados. Chamada malformada (tool desconhecida ou args que não são objeto) volta como dado; a segunda seguida para o run com status.
- **Limites** (`limits.ts`): só teto de passos e de US$ que o dono configurou, mais a rede de segurança (200 passos; 40 sem dono presente). Bateu: um passo final (`toolChoice: "none"`, tools mantidas no pedido) com nota pedindo feito / falta / não confirmado e o gasto. Preço desconhecido nunca vira zero escondido. **Não há corte por tempo no kernel**: o timeout de transporte é do adaptador da porta `Llm` e deve ser generoso (a v2 derrubava passos com 20 s parado/90 s total; ver `docs/ops/v4-baseline.md`).
- **Guarda de laço** (ADR 0003): mesma tool + argumentos + resultado 5 vezes seguidas → nota ao modelo; depois de 2 notas, mais 5 repetições → passo final.
- **Eventos** (`ports.events.emit`): `step`, `text_delta`, `tool_call`, `tool_result`, `card`, `status`, `final`. O mapeamento para o SSE é da F1.12.

### Sem corte por economia (F1.8b)

- **Compactação só com a janela cheia.** `contextTokens` usa o uso real que o provedor informou no último pedido mais uma estimativa do que veio depois; passa de ~85% da `contextWindow("main")` (ajustável em `options.compactAtRatio`), compacta. Custo e gasto nunca disparam. Ordem fixa: (1) *flush*: o trecho que sai vai inteiro para `Store.notes` (`work:<runId>:ctx:<n>`); (2) resumo pelo papel `helper`, com um bloco de runtime que lista as notas, as falas do dono por inteiro, o último erro de cada tool e o resumo (como dado). Resumo que falha não perde nada: o material já está no caderno e o status diz o motivo. Sempre ficam os 2 primeiros blocos e as últimas `keepRecent` mensagens (sem separar chamada de resultado).
- **Saída grande de tool nunca é cortada em silêncio.** Passou de `pageChars` (24000), a saída inteira vai para o caderno (`work:<runId>:out:<callId>`) e o modelo recebe a 1ª página com o ponteiro `note_read(id, offset)`. `note_read` é uma tool `read` do kernel (só notas `work:` do próprio dono). Invariante testado: toda saída chega inteira ou com ponteiro, e as páginas reconstroem o original.
- Não existem teto de pesquisa, orçamento de saída nem corte por custo no kernel.

### Ciclo de vida da tarefa (F1.9)

- **Uma tarefa vive dentro de um turno.** O kernel nunca injeta estado de tarefa de outro run: o contexto de um run novo é o histórico normal mais, no máximo, o aviso de `declinedOffers`. Tool que falhou e foi relatada termina o run como `not_done` (com `unresolved`), sem continuação automática.
- **Oferta = cartão `ask_owner`** (tool do kernel, `endsTurn`): mostra o cartão e encerra o turno (`RunResult.awaiting`). Com `offer`, o cartão vira uma oferta em `Store.conversations` (escopada por dono e conversa) com estado `open → answered | dismissed | ignored`. `ignored` é estrutural: o run seguinte começou com fala do dono (`history` termina em `owner`) sem `cardResponses` tocando no cartão. Dispensada ou ignorada entra em `declinedOffers` e o modelo recebe, como bloco de runtime: `You already offered "X" and the owner declined it. Do not offer it again.`
