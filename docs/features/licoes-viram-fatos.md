# Lições viram fatos

- **Status:** em andamento (relatório entregue; aplicação desligada até o ok do dono)
- **Data:** 2026-11-04
- **Issues/PRs:** harness v3, PR8c

## O que é
No motor v3 o bot deixa de ter "lições" como um mecanismo à parte: o que ele aprendeu passa a ser fato da memória, num lugar só.

## Problema
Hoje existem duas memórias: os fatos (`memory_entries`) e as lições (`bot_lessons`, com escopo, contadores e regra). As lições entram no prompt como um bloco próprio (`LIÇÕES APRENDIDAS`), em forma de ordem ("Ao X, faça Y"), e podem apertar tools antes de rodarem. Duas fontes confundem o modelo, custam tokens e escondem do dono o que o bot "sabe".

## Por que existe
O desenho do v3 (seção 4.4 e decisão D5) manda que a memória guarde fatos declarativos num lugar só. A migração é por relatório revisado pelo dono, nunca automática: lição é texto que o modelo escreveu e pode estar repetida, contraditória ou velha.

## Alternativas descartadas
- Converter tudo sozinho no deploy: grava texto do modelo na memória sem revisão e não dá volta fácil.
- Apagar ou aposentar as lições ao migrar: v1 e v2 ainda as injetam, então o comportamento deles mudaria.
- Reescrever as lições em forma declarativa com um LLM: custo e risco de inventar; o dono edita o texto no relatório se quiser.

## Como funciona
- `packages/shared/src/lesson-facts.ts` (puro): `planLessonFacts` normaliza, deduplica e acha conflito; `renderLessonFactsReport` gera o markdown. Decisões: **fato**, **juntar** (com a melhor das duplicadas) ou **descartar**, cada uma com o motivo. Descarta: vazia, contém segredo (o texto sai por `redactSecrets` e nunca vira fato), maior que 400 caracteres, mais nociva que útil (obsoleta), nunca usada e parada há 180 dias, já presente na memória, não cabe no espaço da memória do bot. Conflito (mesmo assunto e polaridade oposta: "use X" x "nunca use X") marca as duas para revisão; a de placar pior vira "descartar". Lição de conector ou tool leva o contexto na frente do fato.
- `packages/db/src/lesson-migration.ts`: `buildLessonMigrationReport` (somente leitura) e `applyLessonMigration`. Lê só por `listBotLessons(userId, botId)` e `loadStore`, que já filtram por dono; o relatório tem uma seção por dono e bot. A aplicação grava com `addMemoryEntry` (mesmo porteiro da memória: limite e texto inseguro) e `source: "lesson-migration"`.
- No v3, `assembleV3Conversation` ignora o bloco de lições que o worker monta (o worker escolhe o motor depois de montar a memória, e o v1/v2 precisam dele).

### Como rodar
Relatório (somente leitura, o único passo de agora):

```bash
cd apps/worker && pnpm exec tsx ../../packages/db/scripts/lessons-to-facts.ts --out /tmp/licoes.md [--user <id>] [--bot <id>]
```

Aplicação (**não rodar sem o ok do dono**; faça backup; exige `--apply` e `--user`):

```bash
cd apps/worker && pnpm exec tsx ../../packages/db/scripts/lessons-to-facts.ts --apply --user <id> [--bot <id>]
```

Só grava o que o relatório marca como fato e sem conflito pendente. Rodar de novo não duplica (o plano já descarta o que a memória tem e o porteiro recusa texto igual).

## Riscos
- O v3 ainda aplica `rule` de lição nos hooks antes das tools (`createPreToolRunner`); a retirada desse bloqueio é decisão separada do dono (D5: só vale regra pedida pelo usuário).
- Lição de conector/tool só chega ao v3 como fato depois da aplicação; até lá o v3 não as vê (antes só a do bot entrava no prompt estável; as de conector/tool o v3 já não injetava).
- O inspetor do run ainda registra o evento `inspect_lessons` com as lições que o worker montou, mesmo no v3 (que as ignora).
- A conversa de um run que nasceu no v2 e retomou no v3 pode conter o bloco de lições dentro do checkpoint já gravado.
- Detecção de conflito e duplicata é heurística lexical (palavras em comum, negação); por isso só sugere e nunca aplica o que está em conflito.

## Custo
Nenhum token de LLM. O relatório é uma leitura por bot. O v3 passa a mandar menos texto no contexto (sem o bloco de lições).

## Como testar
`pnpm --filter @workspace/shared test` (`lesson-facts.test.ts`), `pnpm --filter @workspace/db test` (`lesson-migration.test.ts`: dois donos, `--apply` do dono, idempotência) e `pnpm --filter @workspace/agent-runtime test` (`engine-v3/prompt.test.ts`: prompt do v3 com e sem lições).
