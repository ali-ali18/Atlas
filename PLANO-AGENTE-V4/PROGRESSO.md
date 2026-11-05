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
| F0 baseline | `feat/harness-v4-f0-baseline` | em andamento | — |

## Decisões do dono (não reabrir)
- Base nova, do zero, em `packages/agent`, sem import do legado (05/11).
- Foco em **controle** de provedor e modelo, não em economia. Nunca travar por cota (05/11).
- Modelos por papel: Sonnet (conversa), Haiku (rápido, ajudantes, sono), Opus (código) (05/11).
- Compras: cartão salvo **sem CVV**. O CVV é digitado pelo dono no cartão de aprovação e vai direto para a loja (05/11).
- Não insistir em tarefa largada: cláusula 17 (05/11).
- O branch `harness/v3` fica **congelado**, só como referência (05/11).
- "EVA" = **Vercel Eve** (05/11).
- Base: `harness/v4` criado a partir da `main` (0.4.1-beta) (05/11).
- Provedor das rodadas reais da F0 por enquanto: **OpenCode Go**, porque os créditos do OpenRouter estão acabando. Modelos: `deepseek-v4.1-flash` (maior franquia; ligar *Global* em Settings › Privacy) e `qwen3.8-flash`, mais `claude-haiku-5-5`, que também está no Go. Anthropic direto: a chave está no ambiente como `CLAUDE_KEY` (verificada, responde 200) e dá Sonnet, Haiku e Opus, com **teto de US$ 10 no total das rodadas reais pela Anthropic**. O comando `matrix` (F0.2) precisa de um teto rígido que aborta antes de passar e de um `--estimate` antes de rodar (05/11). As ideias aproveitadas estão em `02-referencias.md`.

## Checklist

### F0: Baseline medido
- [~] F0.1 (05/11, sessão principal: Sonnet escreve, Opus revisa) Conjunto ouro: 24 tarefas em `packages/evals/tasks/**`, sendo pelo menos 12 de runs reais (`from-run.ts`), incluindo as de insistência.
- [ ] F0.2 Comando `matrix` no CLI de evals (presets × modelos × repetições, relatório em Markdown e JSON).
- [ ] F0.3 Rubrica de qualidade com juiz offline (2 juízes e teto de discordância).
- [ ] F0.4 `classifyRunFailure` em shared, com testes por classe (incluindo `harness.stale_task_injection` e `model.nagging`).
- [ ] F0.5 Rodada do baseline com v2 e v3 em Sonnet, Haiku e 2 baratos de outros provedores, com o relatório em `docs/ops/v4-baseline.md`.
- [ ] F0.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F0.md` fechado.

### F1: Fundação
- [ ] F1.1 Pacote `packages/agent` com `ports/` e guarda de fronteira (sem `@workspace/agent-runtime`).
- [ ] F1.2 `defineTool` (efeito obrigatório) e `defineCapability` (registro, índice, `use_capability`).
- [ ] F1.3 `decide()` puro em shared: 3 estados, `HANDOFF_ACTIONS`, mandatos, matriz superfície × efeito.
- [ ] F1.4 Token de aprovação por hash dos argumentos e `riskFacts`.
- [ ] F1.5 Proveniência (taint) e a regra da trifeta.
- [ ] F1.6 `Receipt` tipado e journal de efeitos.
- [ ] F1.7 Canais: nonce, `<data trust>` e escape.
- [ ] F1.8 Kernel: estados, checkpoint, compactação em 3 passos, limites do dono, passo final honesto.
- [ ] F1.9 Ciclo de vida da tarefa: sem herança entre runs, oferta por cartão com estado, `declinedOffers`, replays de insistência.
- [ ] F1.10 Porta `Llm`: papéis, cadeia de reserva (`pickModelFor`), troca no meio do run, tetos opcionais, aviso ao dono.
- [ ] F1.11 Contrato de trabalho (prompt), com teste de string por seção.
- [ ] F1.12 Eventos compatíveis com o contrato SSE e `chooseRunEngine` → `runAgent` atrás da flag.
- [ ] F1.13 Guardas permanentes: sem regex de comportamento, catraca da ponte, invariantes do contrato, economia.
- [ ] F1.14 Teste de fumaça ponta a ponta no worker com preset `minimal`.
- [ ] F1.A Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F1.md` fechado.

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
- [ ] F8.1 `browser` sobre a porta `Sandbox` e `browser-bench` real.
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

- **05/11/2026 · sessão de planejamento**
  - **Feito:** plano completo em `PLANO-AGENTE-V4/` e pesquisa em `pesquisa/`.
  - **Pela metade:** nada.
  - **Próximo passo:** começar a F0.1, criando o branch `feat/harness-v4-f0-baseline` a partir de `harness/v4`. Se `harness/v4` não existir, criá-lo a partir do ramo da versão atual (`release/<versão>`).
  - **Dúvidas para o dono:** nenhuma (provedor e modelos da F0.5 definidos acima).
