# Progresso do Motor v4: execução e passagem entre contas

> **Este arquivo é a fonte da verdade do andamento.** O dono usa várias contas do Claude: quando a cota de uma acaba, ele abre outra sessão e ela continua daqui. Por isso cada sessão segue o protocolo abaixo **sem exceção**.

## Protocolo de toda sessão (qualquer conta, qualquer agente)
1. **Começar:**
   - `git fetch origin` e sair do branch da fase em andamento, conforme a tabela "Fase atual" abaixo. Se o branch não existir, criar a partir de `harness/v4`.
   - Ler este arquivo inteiro, depois `00-README.md`, `03-arquitetura.md`, `06-contrato-de-comportamento.md` e o trecho da fase em `05-fases.md`.
   - Ler o **Diário de passagem** (fim deste arquivo): é ali que a sessão anterior disse onde parou.
2. **Pegar trabalho:**
   - O primeiro item `[ ]` da fase atual cujas dependências estão `[x]`.
   - Marcar o item como `[~]` com a data e commitar só essa mudança (`chore(plano): F1.3 em andamento`). Isso evita duas contas no mesmo item.
3. **Fazer o item:** código, testes e as regras de `.agents/rules/`.
4. **Fechar o item** num commit atômico do código, mais a marcação:
   - verificar: `pnpm exec turbo typecheck` e as suítes do pacote tocado, todos verdes;
   - trocar `[~]` por `[x]` com a data e o resumo do commit;
   - fazer `git push -u origin <branch>` logo em seguida. O dono autorizou push nos branches do v4 para a próxima conta enxergar.
5. **Antes de parar** (ou quando a cota estiver acabando):
   - escrever uma entrada no Diário de passagem com: o que ficou pronto, o que está pela metade (arquivo e trecho), o próximo passo exato, comandos para verificar e dúvidas para o dono;
   - commitar e fazer o push. **Nunca** deixar trabalho só local.
6. Item pela metade que não dá para commitar verde: commit `wip(...)` num branch `wip/<fase>-<item>`, com push e registro no diário. Nunca no branch da fase.
7. **Auditoria da fase** (processo completo em [`auditorias/README.md`](auditorias/README.md)). Quando todos os itens da fase estão `[x]`:
   - 5 auditores novos, só leitura, um por lente: segurança, bugs, testes, contrato e custo;
   - verificação de cada achado;
   - um commit `fix(...)` por achado confirmado, com teste de regressão;
   - reauditoria das correções;
   - relatório em `auditorias/F<n>.md`.

   De preferência na **conta principal**. Se a sessão atual não puder rodar a auditoria, marque `F<n>.A` como `[!] aguardando conta principal` no diário.
8. **Fase concluída:**
   - itens e auditoria `[x]`, sem achado crítico ou alto aberto;
   - PR para `harness/v4`, com o link na tabela;
   - a "Fase atual" passa para a próxima fase.

**Legenda:** `[ ]` a fazer · `[~]` em andamento · `[x]` feito · `[!]` bloqueado (motivo no diário).

## Fase atual
| Fase | Branch | Status | PR |
|---|---|---|---|
| F0 baseline | `feat/harness-v4-f0-baseline` | **concluída, juntada em `harness/v4`** | #150 |
| F1 fundação | `feat/harness-v4-f1-fundacao` | em andamento (começou em paralelo ao fim da F0) | — |

## Decisões do dono (não reabrir)
- Base nova, do zero, em `packages/agent`, sem import do legado (05/11).
- Foco em **controle** de provedor e modelo, não em economia. Nunca travar por cota (05/11).
- Modelos por papel: Sonnet (conversa), Haiku (rápido, ajudantes, sono), Opus (código) (05/11).
- Compras: cartão salvo **sem CVV**. O CVV é digitado pelo dono no cartão de aprovação e vai direto para a loja (05/11).
- Não insistir em tarefa largada: cláusula 17 (05/11).
- **Genérico no comportamento:** o motor é dedicado ao Atlas, mas não viciado no uso do dono (o v1 tem 13 casos do Bling no runtime). Correção por padrão, nunca por caso; conjunto genérico junto do conjunto do dono (05/11).
- **Open-source como o Atlas:** o motor é dedicado ao Atlas, não é biblioteca genérica. Nada do dono no código; provedores, modelos e tetos configuráveis por quem hospeda (05/11).
- **Navegador sem enxugar:** o bot vê a página inteira (em partes), pela árvore de acessibilidade, sem depender de print; o v3 enxugou e não funcionou (05/11).
- **Sem corte por economia:** nada de cortar contexto, pesquisa ou saída de tool para gastar menos. Só o teto que o dono configurar (05/11).
- O branch `harness/v3` fica **congelado**, só como referência (05/11).
- "EVA" = **Vercel Eve** (05/11).
- Base: `harness/v4` criado a partir da `main` (0.4.1-beta) (05/11).
- Provedor das rodadas reais da F0 por enquanto: **OpenCode Go**, porque os créditos do OpenRouter estão acabando. Modelos: `deepseek-v4.1-flash` (maior franquia; ligar *Global* em Settings › Privacy) e `qwen3.8-flash`, mais `claude-haiku-5-5`, que também está no Go. Anthropic direto: a chave está no ambiente como `CLAUDE_KEY` (verificada, responde 200) e dá Sonnet, Haiku e Opus, com **teto de US$ 10 no total das rodadas reais pela Anthropic**. O comando `matrix` (F0.2) precisa de um teto rígido que aborta antes de passar e de um `--estimate` antes de rodar (05/11). As ideias aproveitadas estão em `02-referencias.md`.

## Checklist

### F0: Baseline medido
- [x] F0.1 (05/11, Sonnet escreveu, Opus revisou; `feat(evals): cenários em subpastas…` + `test(evals): conjunto ouro…`) Conjunto ouro: 24 tarefas em `packages/evals/tasks/**`, sendo pelo menos 12 de runs reais (`from-run.ts`), incluindo as de insistência.
- [ ] F0.1b Trocar os 17 cenários `real-pendente` por runs reais redigidos (`from-run.ts`), quando houver acesso ao banco de produção.
- [x] F0.2 (05/11, Sonnet escreveu, Opus revisou e confirmou os preços da Anthropic) Comando `matrix` no CLI de evals (presets × modelos × repetições, relatório em Markdown e JSON).
- [x] F0.3 (05/11, Sonnet escreveu, Opus revisou; disputada ou inválida fica "pulada" e é contada à parte) Rubrica de qualidade com juiz offline (2 juízes e teto de discordância).
- [x] F0.4 (05/11, Sonnet escreveu, Opus revisou e ajustou: tarefa velha injetada conta sozinha como harness) `classifyRunFailure` em shared, com testes por classe (incluindo `harness.stale_task_injection` e `model.nagging`).
- [x] F0.5 (05/11; relatório em `docs/ops/v4-baseline.md`) Rodada do baseline com v2 e v3 em Sonnet, Haiku e 2 baratos de outros provedores, com o relatório em `docs/ops/v4-baseline.md`.
- [~] F0.A (05/11, 5 lentes Sonnet) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F0.md` fechado.

- [x] F0.7 (05/11, Sonnet escreveu, Opus revisou; achado: o roteador de intenção do v2 só entende o vocabulário do dono, "folha de cálculo" não carrega arquivos) Conjunto `generico`: ~16 cenários com outras pessoas, idiomas, países e lojas, e o juiz recebendo o local do cenário (`04` §1.1).
- [x] F0.6 (05/11; placar corrigido em `docs/ops/v4-baseline.md`) Corrigir os 4 defeitos do eval listados em `docs/ops/v4-baseline.md` (cenários 11, 22 e 23, `skill_read` no ambiente) e rodar de novo só os afetados.

### F1: Fundação
- [x] F1.1 (05/11, Sonnet escreveu, Opus revisou; nota: a porta `Llm` ainda só leva texto — imagem para o papel `vision` entra na F1.10) Pacote `packages/agent` com `ports/`, `adapters/` e guarda de fronteira (sem `@workspace/agent-runtime`), README do motor e varredura que falha com segredo ou dado pessoal no código.
- [x] F1.2 (05/11, Sonnet escreveu, Opus revisou) `defineTool` (efeito obrigatório) e `defineCapability` (registro, índice, `use_capability`).
- [x] F1.3 (05/11, Sonnet escreveu, Opus revisou; taint anula mandato, subagente sem envio/dinheiro, `balanced` = escrita externa pede aprovação) `decide()` puro em shared: 3 estados, `HANDOFF_ACTIONS`, mandatos, matriz superfície × efeito.
- [x] F1.4 (05/11) Token de aprovação por hash dos argumentos e `riskFacts`.
- [x] F1.5 (05/11) Proveniência (taint) e a regra da trifeta.
- [x] F1.6 (05/11) `Receipt` tipado e journal de efeitos.
- [x] F1.7 (05/11) Canais: nonce, `<data trust>` e escape.
- [x] F1.8 Kernel (notas da revisão: persistir e restaurar `RunProvenance.snapshot()` no checkpoint, senão a retomada perde o taint; o `[context]` é o 2º `system` e o adaptador funde se o provedor aceitar só um): estados, checkpoint, compactação em 3 passos, limites do dono, passo final honesto.
- [x] F1.8b Sem corte por economia: compactação só por janela cheia e restaurável, leitura em partes, nenhum teto padrão de pesquisa (decisão do dono, 05/11).
- [x] F1.9 Ciclo de vida da tarefa: sem herança entre runs, oferta por cartão com estado, `declinedOffers`, replays de insistência.
- [x] F1.10 Porta `Llm` (notas da revisão: imagem para o papel `vision`; adaptador da porta `Random` com CSPRNG; TTL opcional no `ApprovalGrant`): papéis, cadeia de reserva (`pickModelFor`), troca no meio do run, tetos opcionais, aviso ao dono.
- [x] F1.11 Contrato de trabalho (nota da revisão: os textos ao usuário do executor, `userMessage` de handoff e de indisponível, hoje estão fixos em pt-BR; passam a sair no idioma do bot por um módulo de copy) (prompt), com teste de string por seção.
- [x] F1.12 (06/11; histórico com assistente, cofre na redação, eventos no contrato SSE, tabelas novas por acréscimo, adaptadores reais, motor v4 atrás de flag por conta e desligado por padrão. Pendências antes de ligar para o dono: cartão de aprovação do v4 no app e a retomada com o clique (grants), histórico da conversa no run, registro de capacidades vazio até a F2, saúde de provedor em Redis, consumidor da fila `atlas-agent-v4`)
- [x] F1.13 (05/11; achou e corrigiu vazamento de segredo no recibo devolvido ao laço; pendente: kernel passar ao executor os valores resolvidos do cofre, ver `it.todo`) Guardas permanentes: sem regex de comportamento, catraca da ponte, invariantes do contrato, economia.
- [x] F1.14 (06/11: bom dia, pesquisa e arquivo pelo worker de verdade com fakes, presets minimal e full, v4 na matriz de evals; ligar o preset e as portas reais de busca e arquivo ao processador fica para a F2) Teste de fumaça ponta a ponta no worker com preset `minimal`.
- [x] F1.A (06/11: 54 achados, nenhum crítico; 5 altos corrigidos; reauditoria com 7 novos, 4 corrigidos) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F1.md` fechado.

### F2: Capacidades do núcleo
- [ ] F2.1 `web` (busca e extração).
- [ ] F2.2 `packages/files` (renderizadores movidos do legado, que passa a importá-los).
- [ ] F2.3 `deliverables` (arquivo, painel, gráfico, `inspect_file`, moldes ABNT, relatório, deck e planilha).
- [ ] F2.4 `memory` (perfil), `tasks` e `settings` (inclui o modelo por papel pelo chat).
- [ ] F2.5 `connectors` (ponte MCP, escopo por dono, classificação de schema, `confirmWrites` → regra).
- [ ] F2.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F2.md` fechado.

### F3: Pesquisa
- [ ] F3.1 Ajudantes com preset filho e política que não concede mais que a mãe.
- [ ] F3.2 `research` (plano, paralelo, caderno de trabalho, fonte por afirmação, formato certo).
- [ ] F3.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F3.md` fechado.

### F4: Agenda
- [ ] F4.1 Migration aditiva em `BotFollowup` e funções puras (`planAgendaItem`, `nextWatchDelay`, `matchEventFilter`).
- [ ] F4.2 Tools `remind_me`, `watch`, `on_event` e `agenda_result`.
- [ ] F4.3 Worker de wake: contrato silencioso, freios e parada após 2 avisos ignorados.
- [ ] F4.4 Seção "Agenda" na Biblioteca (com prévias).
- [ ] F4.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F4.md` fechado.

### F5: Memória, Caderno e Sono
- [ ] F5.1 Model `Note`, rotas `/v1/notes` (IDOR) e tools.
- [ ] F5.2 Seção "Caderno" e regras aprendidas visíveis e editáveis (com prévias).
- [ ] F5.3 Job `sleep`, `MemoryChange` com desfazer e "doctor".
- [ ] F5.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F5.md` fechado.

### F6: Compras
- [ ] F6.1 `product_search` estruturado e card `product`.
- [ ] F6.2 Cartão no cofre sem CVV.
- [ ] F6.3 `checkout` com campo de CVV no cartão de aprovação e `card_fill` (teste de vazamento).
- [ ] F6.4 Mandato opcional.
- [ ] F6.5 `record_purchase` e vigia de entrega automático.
- [ ] F6.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F6.md` fechado.

### F7: E-mail e dia
- [ ] F7.1 `email` e `calendar` (corpo, classificação por campo, prazos, rascunhos, envio com cartão).
- [ ] F7.2 `brief` na agenda (plano do dia).
- [ ] F7.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F7.md` fechado.

### F8: Navegador e código
- [ ] F8.1 `browser` sobre a porta `Sandbox`: árvore de acessibilidade com refs, página inteira em partes (nunca poda escondida) e visão só quando a árvore for pobre.
- [ ] F8.1a Página enorme e feed infinito: mapa primeiro, partes sob demanda, busca na página, "carregar mais" explícito e volume grande em arquivo lido por ajudante. Cenário: resposta no comentário nº 870 de 1.000.
- [ ] F8.1b `browser-bench` real comparando o navegador atual (ADR 0005) com o `agent-browser` da Vercel Labs na VM; fica o que acertar mais.
- [ ] F8.2 `code` (plan/build, edição precisa, verificação).
- [ ] F8.3 Experimento Code Mode.
- [ ] F8.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F8.md` fechado.

### F9: Ponte → zero
- [ ] F9.1 Inventário das pontes, com a contagem inicial anotada aqui.
- [ ] F9.2 Cada ponte nativa: um item por tool, adicionado quando o inventário existir.
- [ ] F9.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F9.md` fechado.

### F10: Corte e remoção
- [ ] F10.1 Critério de corte atendido, com o relatório da matriz.
- [ ] F10.2 Piloto de 7 dias na conta do dono.
- [ ] F10.3 v4 padrão; v2 fica como emergência por 2 versões.
- [ ] F10.4 Remoção de v1, v2, v3 e `agent-runtime` legado.
- [ ] F10.5 ADR 0006 e `docs/features/motor-v4.md`.
- [ ] F10.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F10.md` fechado.

## Diário de passagem
> A entrada mais nova fica no topo. Formato: data · conta ou sessão · fase · feito · pela metade · próximo passo · como verificar · dúvidas.

- **06/11/2026 · sessão principal · F1**
  - **Feito:** F0 juntada em `harness/v4` (#150). F1.1 a F1.13 prontos em `feat/harness-v4-f1-fundacao`.
    - Testes: agent 261, shared 2.734, worker 539, `turbo typecheck` 17/17.
    - O motor v4 está atrás de `ATLAS_ENGINE_V4` + `ATLAS_ENGINE_V4_ACCOUNTS` e desligado por padrão.
    - Com a flag desligada, um run v4 recomeça no motor padrão do bot.
  - **Próximo passo:** F1.14, o teste de fumaça ponta a ponta, e depois a auditoria F1.A.

- **05/11/2026 · sessão principal · F0 (5)**
  - **Feito:** linha de base do conjunto genérico. O Haiku cai de 75% no ouro para 56% no genérico, o que confirma o vício do v2 no uso do dono. Resumo de e-mail e plano do dia falham em todos os modelos.
  - **Gasto acumulado:** ~US$ 5,53, sendo ~US$ 3,26 pela Anthropic.
  - **Próximo passo:** auditoria F0.A (5 lentes) e depois o PR da F0 para `harness/v4`.

- **05/11/2026 · sessão principal · F0 (4)**
  - **Feito:** F0.6.
    - Placar corrigido, sem a tarefa de código: Haiku 75%, Sonnet 65% (1 rep.), Qwen 61%, DeepSeek 58%.
    - O ABNT só funciona com as skills de fábrica carregadas.
  - **Gasto acumulado:** ~US$ 3,91, sendo ~US$ 2,12 pela Anthropic.
  - **Próximo passo:** F0.7 (conjunto genérico) e a auditoria F0.A.

- **05/11/2026 · sessão principal · F0 (3)**
  - **Feito:** F0.5, linha de base em `docs/ops/v4-baseline.md`.
    - Sonnet 58%, Haiku 58%, Qwen 51%, DeepSeek 47%: o teto é do motor, não do modelo.
    - Achado grave de motor: `decision-budget.ts` corta o passo com 20 s parado ou 90 s no total e mata documento longo.
  - **Gasto acumulado:** ~US$ 3,50, sendo ~US$ 1,87 pela Anthropic, de um teto de US$ 10.
  - **Próximo passo:** F0.6 (4 defeitos do eval) e depois a auditoria F0.A.

- **05/11/2026 · sessão principal · F0 (2)**
  - **Feito:** F0.2 (`matrix`, com `--estimate`, `--simulate`, `--max-usd` rígido e provedores `anthropic/`, `opencode-go/` e `openrouter/`) e F0.4.
  - **Gasto real até agora: ~US$ 0,06.** Num teste do F0.2, o Sonnet rodou sem querer 20 execuções reais (haiku pela Anthropic e qwen pelo Go, 10 cenários, 1 repetição) e o processo foi interrompido. Isso confirmou que as chaves e o roteamento funcionam. **Saldo do teto da Anthropic: ~US$ 9,95.**
  - **Estimativa da F0.5** (gold × v2 × haiku, sonnet, deepseek e qwen × 3 repetições): **US$ 8,47**, dos quais US$ 6,66 são do Sonnet. Rodar o Sonnet com 1 repetição, ou só nas capacidades-chave, para caber no teto.
  - **Próximo passo:** F0.3 concluído depois desta entrada. Falta a F0.5 (rodada real) e a auditoria F0.A.

- **05/11/2026 · sessão principal · F0**
  - **Feito:** F0.1. Os 24 cenários ficam em `packages/evals/scenarios/gold/<capacidade>/`. O roteiro mock de todos passa, e `gold.test.ts` exige que uma trajetória ruim por verificação-chave reprove.
  - **Limitações** (estão nas `description`):
    - o 17 (código) é representado pela shell da VM;
    - no 13 não dá para injetar `now` no runtime;
    - o 21 mede só a parte do modelo, porque a nota `continuedWorkNote` do worker vem do banco e o eval não a reproduz.
  - **Medida:** "Bom dia" com ~5.729 tokens no 1º passo; o teto do cenário é 6.600.
  - **Próximo passo:** F0.2, o comando `matrix` com provedores OpenCode Go (`OPENCODE_GO_API_KEY`) e Anthropic (`CLAUDE_KEY`), teto rígido de US$ 10 e `--estimate`.
  - **Como verificar:** `cd packages/evals && pnpm exec tsc --noEmit && pnpm test` (99 verdes) e `pnpm eval list --scenarios gold`.

- **05/11/2026 · sessão de planejamento**
  - **Feito:** plano completo em `PLANO-AGENTE-V4/` e pesquisa em `pesquisa/`.
  - **Pela metade:** nada.
  - **Próximo passo:** começar a F0.1, criando o branch `feat/harness-v4-f0-baseline` a partir de `harness/v4`. Se `harness/v4` não existir, criá-lo a partir do ramo da versão atual (`release/<versão>`).
  - **Dúvidas para o dono:** nenhuma (provedor e modelos da F0.5 definidos acima).
