# ADR 0002: motor v2 do agente, um "trabalhador longo" ao lado do atual

- **Status:** aceito (ok do dono em 31/10, com as sugestões abaixo)
- **Data:** 2026-10-31

## Contexto

O dono não confia no bot para trabalho de verdade, como uma pesquisa de mercado. Hoje ele para no meio, entrega incompleto e pergunta demais. Na mesma tarefa, um concorrente (Grok) vai até o fim.

Parte disso é o modelo. A maior parte, porém, é o **harness**, o motor que roda o modelo. Um mapa do código (31/10) mostrou:

- **Monólito.** `packages/agent-runtime/src/computer-use.ts` tem 9.290 linhas. `runComputerUse` sozinha tem ~4.300 linhas, ~100 opções e ~100 variáveis de estado. Cerca de 120 arquivos de teste giram em torno desse único arquivo.
- **Travas sobrepostas, sem árbitro.** Cada uma tem a sua unidade e pode encerrar o run mesmo com orçamento sobrando:
  - teto soft de 24 passos;
  - `softEvaluate`, em que o próprio modelo declara "concluído" no passo 24 e o run para sem conferência;
  - estagnação (aviso em 3; no 5º passo sem novidade as tools são removidas);
  - stall-guard (aborta em 20 leituras seguidas);
  - repetição (aborta na 2ª);
  - falhas seguidas (6);
  - Jev "stuck", reserva de entregável 80/90% e relógio de 30 min;
  - tetos por tool (`web_search` 10, `web_extract` 12) e saída de 4.096 tokens quando não há tool de arquivo.
- **Uma revisão por run para 5 portões finais.** O primeiro portão que dispara gasta a revisão, e o resto sai "como está".
- **O roteador de intenção decide quais tools existem.** É regex em `intent-router.ts`: "tela" liga o navegador, "relatório" liga arquivos, dados e painéis. Os ajudantes (`delegate_task`) só entram com "N + alvo + verbo", e só leem, até 12 min.
- **O contexto se perde.** Ficam inteiros só os 6 últimos resultados de tool; a memória tem teto de 2.200 caracteres por bot; em grupo não há memória de tarefa.
- **Não dá para medir.** O motivo de término é texto livre em `agent_runs.error`, e `BudgetStopKind` não vira coluna. Não sabemos qual trava mais encerra runs.

A 0.3.4 conserta sintomas: aceite em grupo, espera sem trava, não reperguntar. Esses consertos valem para qualquer motor, mas não resolvem a arbitragem das travas nem o monólito.

## Decisão

Construir um **motor v2 ao lado do atual**, ligado **por bot**. O v1 continua rodando para todo o resto até o v2 provar que entrega mais pelo mesmo custo.

### Decisões do dono (31/10)

- **Orçamento padrão de "trabalho longo" (substituído em 01/11, ver nota abaixo):** US$ 0,50 e 20 min por tarefa, ajustável por bot.
- **Bot piloto:** Radar de Mercado.
- **Modelo do piloto: opção configurável, não fixa.** O padrão é o mais barato. O piloto mede o custo real de três combinações antes de escolher:
  - Haiku sozinho;
  - Sonnet coordenando com Haiku nos ajudantes;
  - Sonnet em raciocínio baixo.
  Sonnet só vira padrão se a diferença de custo for pequena para o ganho de entrega.

### Princípios do v2

0. **Duas portas.** Conversa curta é respondida na hora, sem trabalho pesado. Tarefa com ação vira trabalho em segundo plano: o bot responde "já vejo isso" em uma linha, o trabalho roda à parte e o resultado chega depois na conversa. Se falhar, ele avisa também. Quem escolhe a porta é o próprio modelo, com uma regra de segurança: pedido com ação nunca fica sem tools.
1. **Laço simples.** O modelo chama tools até decidir que terminou. Não há teto de passos "soft" nem tools removidas por heurística no meio do trabalho.
2. **Um árbitro só (Supervisor), com uma unidade só: dinheiro e tempo.**
   - Cada tarefa tem um orçamento em US$ e minutos, vindo do perfil: *conversa* (barato e curto) ou *trabalho longo* (maior).
   - Perto do fim do orçamento, o árbitro avisa uma vez e reserva o necessário para **entregar**. Ele não aborta.
   - Repetição real (mesma tool, mesmos args, mesmo resultado) vira um aviso ao modelo, não uma morte do run.
3. **Lista de tarefas obrigatória em trabalho longo,** no estilo TodoWrite e persistida. Só se termina com **todos os itens feitos ou explicitamente descartados com motivo**. É a "lista de aceitação" que hoje não existe.
4. **O forte coordena, os baratos trabalham.** O modelo do bot coordena: planeja, decide e escreve a entrega. Os ajudantes podem usar um modelo mais barato para o trabalho braçal (ler páginas, extrair dados). O modelo não é trocado no meio do laço principal, porque isso quebra o cache e faz o coordenador perder detalhe.
5. **Ajudantes de verdade.**
   - Ajudantes paralelos com orçamento próprio, disparados pelo modelo quando o trabalho se divide; não por regex.
   - Escrevem num **caderno da tarefa** (notas e artefatos com referência), em vez de devolver um texto que o pai precisa reverificar.
   - Leitura por padrão; escrita só nas classes que a política já permite.
6. **Catálogo de tools sempre visível e curto.** O índice das famílias fica no prompt, e o modelo carrega o grupo com `tool_search`. O regex atual vira só uma *dica* de pré-carga, nunca um portão.
7. **Contexto sem amnésia.**
   - O caderno da tarefa e a lista sobrevivem à compactação.
   - Resultados grandes viram referência relível; nada é descartado em silêncio.
   - A memória ganha mais espaço.
   - Quatro memórias separadas: trabalho (janela atual), caderno da tarefa (notas e fontes do trabalho em andamento), plano (lista de tarefas) e longo prazo (preferências e histórico, consultados por busca).
8. **Perguntas pela política, não pelo humor do modelo.**
   - Uma rodada no começo, agrupada e com padrão sugerido.
   - No meio do trabalho, só para irreversível, saída para fora, dinheiro ou dado sensível; a mesma matriz da 0.3.4.
   - Ao falhar, tenta outro caminho e volta com diagnóstico, solução e uma pergunta sim/não.
9. **Entrega única.** Trabalho longo termina num documento (ou painel) com fontes, suposições e "o que não deu para confirmar". O chat recebe só um resumo e o link.
10. **Raciocínio controlável** por bot e por chat (desligado, baixo, médio, alto), para usar um modelo mais forte em nível baixo.
11. **Observável desde o dia 1.**
    - `stopReason` estruturado por run (enum) e evento próprio.
    - Custo, passos, perguntas feitas e itens da lista entregues ou descartados.

### O que NÃO muda (contrato duro)

- Os 10 status do run, o protocolo de lease/fence, a regra de 1 run ativo por conversa e o payload do job (`{runId}`).
- `run_events` com `seq`, SSE (`Last-Event-ID`) e os tipos de evento `ComputerUseEvent`: `assistant_delta`, `done`, `tool_call`/`tool_result` com o mesmo `id`, os cards e `paused`/`cancelled`/`error`.
- Cards persistidos (`role` + `{v:1, kind}`), identidade estável (`confirmId`, `chartId`, `pageId`, `routineId`) e o dedupe do front.
- `SkillPendingIntent`/`confirmId`, `transcriptSeed`, `usageJson.costUsd`, `agent_steps` e os pontos de entrada (chat, rotina, grupo, bot→bot, subagente).
- Os executores de tool (cofre, conectores, rotinas, painéis, navegador): **são reaproveitados**, não reescritos.

### Fases

| Fase | O que entra | Risco | Prova |
|---|---|---|---|
| **F0 · Medir** (também no v1) | `stopReason` enum gravado no worker (`agent-run.ts` ~1674/1757) e consulta/painel "por que os runs terminam" | baixo | números de 7 dias antes de mexer |
| **F1 · Extrair tools** | executores de tool saem de `computer-use.ts` para um registro (`tools/registry`), sem mudança de comportamento | médio | suítes atuais verdes, replays iguais |
| **F2 · Laço v2** | `engine-v2/` com laço, Supervisor, lista de tarefas, eventos do contrato e checkpoint `version: 2`; atrás de `policyJson.engine = "v2"` | médio | replays com LLM mockado e "Bom dia" barato |
| **F3 · Trabalho longo** | ajudantes + caderno da tarefa + entrega em documento + raciocínio controlável | médio | replay da pesquisa de mercado do grupo |
| **F4 · Piloto** | bot de pesquisa no v2; avaliação lado a lado com o v1 em ~10 tarefas reais (taxa de conclusão, perguntas, custo) | baixo | relatório para o dono comparar com o Grok |
| **F5 · Migrar** | os outros bots um a um; o v1 é aposentado quando nenhum bot o usa | médio | — |

Cada fase é um PR (ou poucos) contra o ramo da versão, com auditoria independente.

## Alternativas descartadas

- **Só afrouxar os números do v1** (passos, tetos por tool): já parcialmente feito. Não resolve a falta de árbitro (qualquer trava ainda encerra) nem o monólito, onde cada ajuste quebra outro.
- **Reescrever tudo de uma vez e trocar no deploy:** risco alto de quebrar cofre, conectores, rotinas e grupos ao mesmo tempo. Sem comparação lado a lado, o dono não teria como confiar.
- **Adotar um framework pronto** (SDK de agente de um provedor, LangGraph):
  - o Atlas precisa de vários modelos via OpenRouter, cards persistidos, lease e retomada próprios;
  - o ganho seria só o laço, que é a parte mais simples.
  - Fica para reavaliar na F2, se surgir um SDK multi-modelo que respeite o contrato acima.

## Nota de decisão (01/11): o árbitro do trabalho longo deixou de ser US$ e passou a ser progresso e tempo

Um teto fixo em dólar (US$ 0,50, depois ideias de US$ 3) não funciona: o preço varia demais entre modelos e um modelo caro estoura qualquer valor numa pesquisa; além disso o bot chegava perto do teto e ficava sem dinheiro para escrever o documento. Decisão do dono: em `long_work` o supervisor muda para as fases de lacunas e de escrita pelo **progresso da tarefa** (lista concluída, 4 passos seguidos sem progresso no caderno e na lista) ou pelo **tempo** (70% do tempo máximo, 60 min por padrão e até 180) e pelos **passos** (70% do teto de 200). A escrita nunca é bloqueada nem cortada por custo. **Dinheiro é opcional**: sem teto em US$ por padrão; o dono pode preencher um gasto máximo por tarefa longa (teto duro, com a escrita ainda garantida), e o teto por execução da conta (padrão US$ 0,25) não se aplica ao trabalho longo no chat com humano. Chat curto e v1 não mudam. O card "Continuar pesquisa (+US$ X)" deixou de ser oferecido (fica só para cards antigos). Detalhes e constantes em `docs/features/motor-v2.md`.

## Consequências

- **Custo por tarefa longa sobe**, porque o v2 trabalha até o fim. Em troca, ele fica **limitado por progresso e tempo** (e, se o dono quiser, por um gasto máximo opcional em US$); a decisão de 31/10 de um orçamento fixo em US$ foi substituída pela nota de 01/11 acima.
  - Conversa curta não deve ficar mais cara; o teste de economia ("Bom dia") continua valendo.
  - O padrão de "trabalho longo" agora é sem teto em US$ e 60 min de tempo máximo, ajustável por bot (sugestão inicial de 31/10, US$ 0,50 e 20 min, substituída em 01/11).
- **Dois motores convivendo** por algumas semanas: mais código para manter e testes dos dois. Mitigação: as tools são compartilhadas desde a F1.
- **Checkpoint v1 × v2:** run em andamento continua no motor em que começou (o motor é gravado no `budgetJson` na criação).
- **Decidido:** ver "Decisões do dono".
