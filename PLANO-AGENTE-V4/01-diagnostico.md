# Diagnóstico: v2, v3 e o que falta

Fontes:
- leitura de `main` (v2) e de `origin/harness/v3` (≈60 commits, +31k linhas, 272 arquivos);
- ADR 0002 e 0003;
- `docs/features/motor-v2.md`.

Os caminhos citados são relativos a `packages/agent-runtime/src/`.

## Motor v2 (padrão hoje)
- Laço em `engine-v2/run.ts:1397-1520`, com `supervisor.ts` como árbitro único.
  - Travas: aborta só por `loop_repeat` e por 10 falhas globais; o resto vira nota.
  - Perfis `chat` e `long_work`: promove com 3 ou mais tarefas ou na primeira tool de navegador.
- Tem o que o v3 perdeu: caderno por run (`engine-v2/notebook.ts`), ajudantes (`delegate`, `helpers.ts`), orçamento dividido e entrega de documento.
- **Ainda descarta a resposta do modelo:** `delivery.ts` retira o rascunho de mais de 1500 palavras sem arquivo (`assistant_discard` `missing_file`).
- Regex que ainda decide:
  - `context/intent-router.ts:13,64,66,182-194`: dica de pré-carga de tools;
  - `engine-v2/run.ts:1509`: regex de nome de tool decide a promoção;
  - `supervisor.ts:50,61,187`: listas de tools por regex de nome.

## Motor v3 (`origin/harness/v3`, atrás de flag)
**Ganhou:**
- Laço de 206 linhas com estados explícitos (`engine-v3/loop.ts`).
- `defineTool` com efeito declarado (`read`, `write_internal`, `write_external`, `send`, `money`, `public_link`, `credential`).
- Política pura que decide de verdade (`policy/decide.ts`), com cartão genérico de aprovação e a mesma chamada executada uma vez.
- Catálogo com núcleo pequeno, manifesto e `tool_search`/`tool_call`.
- Prompt em 3 blocos (estável, `[context]`, `[runtime]`).
- Compactação em 2 passos com *memory flush*.
- Checkpoint por passo com journal de escrita (não repete efeito).
- Esperas do dono com `waitMinutes`, limite que pergunta "Continuo?", `schedule_return`, lições viram fatos.
- Eval T1–T13 lado a lado com o v2.

**Por que o usuário não sente diferença:**
1. **Contrato de trabalho raso.** `engine-v3/prompt.ts:23-33` tem 9 linhas e nada sobre:
   - antecipar a próxima necessidade (ex.: trazer o conteúdo do e-mail, não só o assunto);
   - escolher o formato de entrega;
   - pesquisar em profundidade;
   - conferir o próprio artefato.
2. **O que o usuário mais valoriza saiu do núcleo.** `create_file`, `create_page`, pesquisa e lembrete só aparecem pelo manifesto (12 mil caracteres) ou por `tool_search`. Isso é um passo extra e um ponto de erro para modelo barato. O núcleo por uso (`catalog.ts`) só promove tools usadas 3 ou mais vezes em 30 dias.
3. **Sem caderno, ajudantes e trabalho longo.** `engine-v3/tool-context.ts:16` deixa os três explicitamente de fora. A pesquisa larga depende de o modelo encadear `web_search` sozinho.
4. **Sem agenda própria.** `schedule_return` só existe com `ownerWait` + conversa (`prepare.ts:107`). Não há vigia recorrente leve, só rotina. Não há intenção por evento ("quando chegar o e-mail X").
5. **Canal misturado.** `[context]`, `[runtime]`, empurrões e steering são todos mensagens `user` com prefixo. Uma página ou o próprio usuário pode escrever `[runtime]`. A defesa é uma linha do prompt e um `startsWith` (`isContextMessage`).
6. **Texto ainda decide.**
   - `prepare.ts:70-71` (`isBotConfigEventObjective`, marcadores com `includes`) decide `humanTurn`, que decide esconder ou pedir.
   - `tools/set-engine.ts:37` (`looksLikeEngineRequest`) decide se `set_engine` existe.
   - `hooks/pre-tool-runner.ts`: as lições `rule`/`confirm_always` ainda barram antes da tool.
7. **Ainda mexe na resposta.**
   - `loop.ts:170-172` e `:90-93`: texto vazio vira texto fixo.
   - `sanitizeAssistantText` (`model-step.ts:108`) descarta linhas "sem letra".
   - Empurrão `open_list` (`nudges.ts:55-58`) faz o turno continuar por causa de uma lista.
8. **Nada prova que melhorou.** O comparativo exige modelo real (`evals/src/engine-compare/v3/criteria.ts`) e só o mock roda em CI.
   - O que foi medido é custo: navegador −43% de entrada, schema de 8k para 4,7k caracteres.
   - Ninguém mede qualidade de pesquisa, de documento nem proatividade.

## Lacunas de produto (não existem em lugar nenhum)
- **Busca de produto/preço com card.** `market/` só cobre cotação, câmbio, cripto e clima.
- **Pagamento ou cartão salvo**, e acompanhamento de entrega de pedido.
- **Caderno persistente do usuário.** Hoje só existem `MemoryEntry` (≤ 2200 caracteres por bot) e o caderno por run do v2.
- **Vigia leve recorrente** que não seja `Routine`. `BotFollowup` tem `stages`, mas é de uma vez.
- **Replay de um run real de produção com outro modelo.** `evals/src/from-run.ts` gera o cenário, mas não roda a matriz.

## O que não pode mudar (contrato do ADR 0002)
- os 10 status do run;
- lease/fence;
- um run ativo por conversa;
- o job `{runId}`;
- `run_events.seq`;
- os tipos de `ComputerUseEvent`;
- as identidades dos cards;
- o contrato `ComputerUseParams` → `RunComputerUseResult`.

O v4 entra pela mesma porta do v3: `chooseRunEngine` mais flag.
