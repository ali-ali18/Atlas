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
| F1 fundação | `feat/harness-v4-f1-fundacao` | **concluída, juntada em `harness/v4`** | #151 |
| F2 capacidades | `feat/harness-v4-f2-capacidades` | **concluída, juntada em `harness/v4`** | #152 |
| F3 pesquisa | `feat/harness-v4-f3-pesquisa` | **concluída, juntada em `harness/v4`** | #153 |
| F4 agenda | `feat/harness-v4-f4-agenda` | **backend juntado em `harness/v4`** (#155); tela da Agenda juntada | #155, #157 |
| F5 memória | `feat/harness-v4-f5-memoria` | **backend juntado em `harness/v4`** (#154); telas do Caderno, regras e sono juntadas | #154, #157 |
| F6 compras | `feat/harness-v4-f6-compras` | concluída (08/11): produto, compra registrada, cartão sem CVV, checkout com CVV, mandato; auditoria + reauditoria em `auditorias/F6.md` | #158 |
| F7 e-mail e dia | `feat/harness-v4-f7-email-dia` | **concluída, juntada em `harness/v4`** | #164 |
| F8 navegador e código | `ccr-b75b9244-ih1osu` (a partir de `feat/harness-v4-f8-navegador-codigo`) | **concluída** (09/11): auditoria e reauditoria em `auditorias/F8.md`; F8.3 opcional em aberto | #165 (issue-mãe) |

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
- **O v4 só é ligado (nem na conta do dono) quando estiver completo.** Até lá a validação é só pelos testes automáticos e pela matriz de avaliação; nada de flag ligada para teste no app (06/11).
- Perfil do bot sempre pede confirmação; gravar memória depois de ler conteúdo de fora (e-mail, página, conector) pede confirmação com "Agora não" e expira sem resposta; o resto da memória segue automático (06/11).
- **Merge autorizado (07/11):** fase terminada, auditada, reauditada e com a verificação verde pode ser juntada em `harness/v4` pelo agente, sem pedir de novo. Merge na `main` continua só com o ok do dono.
- **Sem horário de silêncio no v4 (07/11):** a agenda do v4 respeita o horário pedido e não empurra lembrete, vigia nem aviso para fora de um "silêncio". Os freios de custo (intervalo mínimo, espaçamento, teto diário, parada após avisos ignorados) continuam. O v2 em produção não muda.

## Checklist

### F0: Baseline medido
- [x] F0.1 (05/11, Sonnet escreveu, Opus revisou; `feat(evals): cenários em subpastas…` + `test(evals): conjunto ouro…`) Conjunto ouro: 24 tarefas em `packages/evals/tasks/**`, sendo pelo menos 12 de runs reais (`from-run.ts`), incluindo as de insistência.
- [ ] F0.1b Trocar os 17 cenários `real-pendente` por runs reais redigidos (`from-run.ts`), quando houver acesso ao banco de produção.
- [x] F0.2 (05/11, Sonnet escreveu, Opus revisou e confirmou os preços da Anthropic) Comando `matrix` no CLI de evals (presets × modelos × repetições, relatório em Markdown e JSON).
- [x] F0.3 (05/11, Sonnet escreveu, Opus revisou; disputada ou inválida fica "pulada" e é contada à parte) Rubrica de qualidade com juiz offline (2 juízes e teto de discordância).
- [x] F0.4 (05/11, Sonnet escreveu, Opus revisou e ajustou: tarefa velha injetada conta sozinha como harness) `classifyRunFailure` em shared, com testes por classe (incluindo `harness.stale_task_injection` e `model.nagging`).
- [x] F0.5 (05/11; relatório em `docs/ops/v4-baseline.md`) Rodada do baseline com v2 e v3 em Sonnet, Haiku e 2 baratos de outros provedores, com o relatório em `docs/ops/v4-baseline.md`.
- [x] F0.A (05/11, 5 lentes, 24 corrigidos, reauditoria com 2 corrigidos e 4 aceitos; ver `auditorias/F0.md`) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F0.md` fechado.

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
- [x] F1.A (06/11: ~50 achados, nenhum crítico; altos corrigidos; reauditoria com 7 novos, 4 corrigidos) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F1.md` fechado.

### F2: Capacidades do núcleo
- [x] F2.1 (06/11: adaptador real SearXNG + DuckDuckGo por injeção; página inteira; ligar no worker na F2.6) `web` (busca e extração).
- [x] F2.2 (06/11) `packages/files` (renderizadores movidos do legado, que passa a importá-los).
- [x] F2.3 (06/11: capacidade lazy; adaptador no worker na F2.6) `deliverables` (arquivo, painel, gráfico, `inspect_file`, moldes ABNT, relatório, deck e planilha).
- [x] F2.4 (06/11: portas e fakes; adaptador de banco e `roleModels` por bot na F2.6; perfil sempre confirma; memória depois de leitura não confiável confirma, com "Agora não" e expiração) `memory` (perfil), `tasks` e `settings` (inclui o modelo por papel pelo chat).
- [x] F2.5 (06/11: porta e fake; adaptador real na F2.6) `connectors` (ponte MCP, escopo por dono, classificação de schema, `confirmWrites` → regra).
- [x] F2.6 (06/11: adaptadores reais no worker; histórico, cartões, retomada com aprovar/"Agora não"/handoff e expiração em 24h; taint entre runs pela coluna `agent_runs.v4Provenance`; rotas `/v1/agent-v4`. Falta só o cartão no app, feito em outra conta sobre o contrato da rota) Pré-requisitos para ligar (da auditoria F1).
- [x] F2.A (06/11: 23 achados, nenhum crítico ou alto; 21 corrigidos, 2 aceitos; reauditoria com 4 novos baixos, 1 corrigido) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F2.md` fechado.

### F3: Pesquisa
- [x] F3.1 (06/11) Ajudantes com preset filho e política que não concede mais que a mãe.
- [x] F3.2 (06/11; o eval v4 monta o preset `full` com ajudantes reais) `research` (plano, paralelo, caderno de trabalho, fonte por afirmação, formato certo).
- [x] F3.A (06/11: 8 achados, 1 alto; todos corrigidos; reauditoria com 2 baixos, 1 corrigido) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F3.md` fechado.

### F4: Agenda
- [x] F4.1 (06/11: colunas `agendaKind`, `intervalMinutes`, `untilAt`, `maxRuns`, `runCount`, `eventFilterJson`, `noChangeStreak`, `lastResultJson`, `lastNoticeAt`, `ignoredStreak`, `grantJson`, `endReason`; coluna separada `agendaKind` em vez de estender `kind`, para o v2 não tratar item novo como lembrete; `shared/agenda.ts` com testes de fuso, virada de dia e DST) Migration aditiva em `BotFollowup` e funções puras (`planAgendaItem`, `nextWatchDelay`, `matchEventFilter`).
- [x] F4.2 (06/11: capacidade lazy `agenda` no preset full, `agenda-run` só nos runs de agenda, criação silenciosa, adaptador real no worker escopado por dono com teste IDOR; kernel ganhou `endsRun`) Tools `remind_me`, `watch`, `on_event` e `agenda_result`.
- [x] F4.3 (06/11: varredura no padrão do modo proativo do v2, só com `ATLAS_ENGINE_V4`; run proativo ligado a item vai ao v4; ignorado = dono não abriu a conversa nem escreveu depois do aviso; run sem `agenda_result` não fala, exceto lembrete) Worker de wake: contrato silencioso, freios e parada após 2 avisos ignorados.
- [x] F4.4 (07/11: rotas `GET /v1/agenda` e `POST /v1/agenda/:id` (pausar, retomar, cancelar) sobre as funções de `packages/db/src/agenda.ts`, 404 para alheio e corpo estrito; o sinal de "motor v4 ligado para a conta" é o campo `enabled` da própria lista (mesma flag e contas do worker), sem ele a seção não é desenhada; seção recolhível na Biblioteca com frases ("Amanhã às 10:00", "A cada 2 h até 20/11"), estado, próxima conferência, última novidade, encerrados com o motivo, interruptor de pausa e cancelar só no hover/pressão longa com confirmação; prévias em `apps/web/e2e/agenda-previews.spec.ts`) Seção "Agenda" na Biblioteca (com prévias).
- [x] F4.A (06/11: auditoria + reauditoria, 15 achados e mais N1–N3 corrigidos com teste; `auditorias/F4.md` fechado) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F4.md` fechado.

### F5: Memória, Caderno e Sono
- [x] F5.1 (06/11: tabela `notes` nova, não extensão de `agent_notes`; seis tools `note_*` na capacidade `memory` lazy; rotas `/v1/notes` com IDOR testado em banco real; títulos fixados no `[context]` com teto técnico; regras aprendidas: API `/v1/bots/:botId/rules`, agora valendo no autorizador; falta a UI) Model `Note`, rotas `/v1/notes` (IDOR) e tools.
- [x] F5.2 (07/11: seção recolhível "Caderno" na Biblioteca com notas, "O que o bot aprendeu" e "Revisão da noite"; só aparece com o sinal `capabilities.engineV4` de `GET /v1/settings`; cliente em `lib/atlas-api.ts`; prévias em `apps/web/e2e/__previews__/caderno/`) Seção "Caderno" e regras aprendidas visíveis e editáveis (com prévias).
- [x] F5.3 (06/11: backend completo; fonte = só fala do dono citada por id; 23:30 no fuso do dono; uma chamada `sleep` por bot por dia; `MemoryChange` estendido para notas, origem `sleep`, relatório e desfazer; doctor aos domingos só propõe; skills e casos de eval só propostas; falta a UI do relatório) Job `sleep`, `MemoryChange` com desfazer e "doctor".
- [x] F5.A (06/11: 19 achados, 1 alto; 17 corrigidos, 2 aceitos; reauditoria com 5 baixos, 1 corrigido) Auditoria: 5 lentes, verificação, correções com teste, reauditoria e `auditorias/F5.md` fechado.

### F6: Compras
- [x] F6.1 (07/11: capacidade lazy `shopping`, `product_search` com JSON-LD/OpenGraph em `shared/product.ts`, total = preço + frete com frete desconhecido explícito, HTML pela proteção SSRF do extrator (`fetchPageHtml`), card `product` com fotos, desconto, nota e comparação; prévias em `apps/web/e2e/__previews__/compras/`) `product_search` estruturado e card `product`.
- [x] F6.2 (07/11, frente C: tabelas `saved_cards` e `purchase_mandates` por acréscimo, `secretsEnc` com a caixa dos conectores, rotas `/v1/cards` com IDOR testado em Postgres, validação Luhn/validade, corpo estrito sem CVV, tela em Configurações › Cofre; prévias em `apps/web/e2e/__previews__/compras/`) Cartão no cofre sem CVV.
- [x] F6.3 (07/11, frente C: `checkout` em `capabilities/shopping/checkout.ts`, canal efêmero do CVV (Redis selado, GETDEL, chave = pedido), `card_fill` sobre a porta `Sandbox` com fake, handoff pós-efeito sem repetir, `CvvField` em `packages/ui`, cartão de compra mínimo em `ai-elements/purchase`, rota de resposta com `cvv` só para compra; testes de vazamento em evento, pedido ao modelo, journal, recibo e checkpoint. Falta na F8: o adaptador real de `card_fill` na VM) `checkout` com campo de CVV no cartão de aprovação e `card_fill` (teste de vazamento).
- [x] F6.4 (07/11, frente C: tabela `purchase_mandates`, rotas `/v1/purchase-mandate`, mandato carregado pelo worker; com mandato o cartão pede só o CVV (`inputOnly`) e o uso é gasto e gravado; falta a tela do mandato, que por ora se cria pela API) Mandato opcional.
- [x] F6.5 (07/11: `record_purchase` `write_internal` (após a auditoria: confirma quando o run leu conteúdo de fora, sai do run de agenda, ganha `purchase_update`/`purchase_delete`; checkout pago registra sozinho), tabela `purchases`, rotas `/v1/purchases` com IDOR testado, card `purchase`, vigia de entrega criado em silêncio pela agenda do preset (12 h, ~30 dias); o `checkout` da frente C é uma tool da mesma capacidade `shopping`) `record_purchase` e vigia de entrega automático.
- [x] F6.A Auditoria (08/11: duas leituras, 19 achados corrigidos com teste; reauditoria com 11 achados novos, 10 corrigidos e 1 adiado para a tela do mandato; aceitos registrados em `auditorias/F6.md`. Pendências da F6 fora deste PR: tela e tool de chat do mandato, cards `product`/`purchase` no app mobile, `card_fill` real na F8.0)

### F7: E-mail e dia
- [x] F7.1 `email` e `calendar` (corpo, classificação por campo, prazos, rascunhos, envio com cartão).
  - [x] F7.1 e-mail (08/11, frente E: `email_list`, `email_read`, `email_triage`, `email_draft` e `email_send` nativos para o Gmail do dono e a caixa do bot; escopo `gmail.send`; cards de triagem e rascunho; intenção "quando chegar o e-mail" pelo webhook da caixa do bot; 2 cenários seed v4; `docs/features/email-v4.md`). Falta a ingestão do Gmail para o gatilho.
  - [x] F7.1 calendário (08/11, frente K): capacidade lazy `calendar` (5 tools, Google Agenda do dono pelo cofre do conector), conflito por horário, convite como `send`, só leitura no run de agenda, cartão `calendar` em 3 idiomas.
- [x] F7.2 `brief` na agenda (plano do dia) (08/11, frente K: `brief_set` um por bot no horário exato, run com `brief_sources` e `day_plan`, cartão `day-plan`, fontes por portas com e-mail opcional, modelo de ajudante do bot). A porta de e-mail do brief (`ports/brief.ts`, `listRecent`) está ligada à porta real de e-mail no worker (`v4-adapters/brief-email.ts`, passada em `processors/agent-run.ts` só no run de brief; nunca lê o corpo; login expirado = `needs_connection`).
- [x] F7.A Auditoria (08/11): auditoria, 15 correções, reauditoria (N1 a N8) e `auditorias/F7.md` fechado. Falta só o PR para `harness/v4` e o merge.

### F8: Navegador e código
- [x] F8.1 `browser` sobre a porta `Sandbox` (09/11, frente B, #167): capacidade lazy com 11 tools (`browser_open/map/read/find/act/load_more/wait/tabs/screenshot/export/digest`), kinds `browser.*` documentados em `protocol.ts`, handlers no control server (`POST /browser/v4`, `browser-v4.mjs` e cia., testados em Chromium real) e `apps/worker/src/v4-adapters/browser-actions.ts` (a integração da frente A registra por kind e passa `browser: true` ao preset). Efeito pelo `intent` declarado (`browse` = leitura, `submit` = `write_external` com `what`); a VM recusa por estrutura o envio de formulário declarado como `browse`; senha, código e captcha só o dono. Run de agenda: só leitura. Visão só com árvore pobre. Doc: `docs/features/navegador-v4.md`. Falta: ligar o adaptador `Sandbox` real (frente A).
- [x] F8.1a Página enorme e feed infinito (09/11, frente B): mapa primeiro (tamanho de cada lista, total declarado pela página), partes numeradas que dizem onde estão e quanto falta, busca na VM, "carregar mais" explícito, arquivo da VM lido em blocos por ajudantes (`browser_digest`). Teste dos 1.000 comentários com a resposta no nº 870: maior pedido ao modelo ~4,1 mil tokens contra ~24,4 mil da lista (fake + LLM roteirizado); no Chromium real a busca acha o nº 870 com ref; cenário seed v4 `seed-navegador-1000-comentarios-no-870` (mock e `--simulate` passam).
- [x] F8.0 (09/11, frente A: adaptador `Sandbox` no worker com registro de `kind`s, `card_fill` real no control server com host e total conferidos antes de pagar, challenge sem repetir o pagamento, egress/SSRF do Chromium e `CapDrop`/`PidsLimit`; `docs/features/pagamento-real-vm-v4.md`; falta a prova ponta a ponta com loja e VM reais, no piloto do dono) Adaptador real de `card_fill` (pendência OBRIGATÓRIA da F6, ver contrato em `packages/agent/src/ports/payment.ts`): na página final da loja, ler o host que cobra e o total cobrado e devolver `declined`/`failed` SEM pagar se divergirem de `merchant`/`amount`; NUNCA gravar `params` (número, CVV, titular) em log, trace, journal ou mensagem de erro. Teste com VM fake: host trocado e total diferente não pagam; nenhum segredo em log.
- [x] F8.2 `code` (09/11, frente C: capacidade lazy `capabilities/code/` com 9 tools sobre a porta `Sandbox` (kinds `code.*` em `kinds.ts`), portão de comando reaproveitando `shared/dev-command-approval`, `.env` e caminho sensível = `credential`, saída redigida e não confiável, presets de política `plan`/`build` em `presets/policy-presets.ts`, adaptador `apps/worker/src/v4-adapters/code-actions.ts` (escopo usuário + sessão), seed v4 com repositório real em `packages/evals`. Pendências: abrir PR pelo conector GitHub; o integrador registra o tratador no dispatcher da frente A e liga `code: {}` no preset; `rootIsWorkspace` no adaptador; docs em `docs/features/codigo-v4.md`) `code`: plan/build, edição precisa, verificação.
- [x] F8.1b `browser-bench` real (09/11, com ok do dono, Haiku): T11 empata 3/3; rodada 2 (T7 iframe/shadow DOM e T10 canvas) dá atual 9/9 contra `agent-browser` 6/9. **Fica o navegador atual (ADR 0005).** Ressalva da reauditoria: a rodada real rodou com o guarda de egress desligado e o gabarito (`/__truth`) servido no mesmo host que o modelo navegava; resultado vale como indicativo (issue aberta).
- [ ] F8.3 Experimento Code Mode: **opcional, fica em aberto** (só liga se ganhar na matriz; não feito nesta fase).
- [x] F8.A Auditoria (09/11): auditoria com 15 achados corrigidos; reauditoria independente (2 leituras Sonnet com a skill de segurança da Cloudflare, 36 itens incluindo dúvidas) validada por uma leitura Opus; 14 correções novas com teste (token do control server, proxy, portão de comando, envio de formulário, digitação como saída, `card_fill` pós-clique, teto de saída, cartões em pt-BR); adiados e aceitos em `auditorias/F8.md`.

### F9: Ponte → zero
- [x] F9.1 Inventário das pontes (09/11). **Catraca = 0**: a pasta `packages/agent/src/legacy-bridge/` não existe, e `boundary.test.ts` proíbe `@workspace/agent-runtime` dentro de `packages/agent`, então nenhuma tool do legado passa ao v4 por ponte. O que resta do legado no caminho do v4 são **5 adaptadores do worker** que importam helpers de `@workspace/agent-runtime`: `v4-adapters/calendar.ts` (`googleFetch`, OAuth, `openSecrets`), `email.ts` (`googleJson`, `emailService`, `buildMcpClientConfig`), `mcp.ts` (`loadMcpRuntime`: o cliente MCP inteiro), `code-actions-real.ts` (`getGithubToken`) e `payment.ts` (`openCardSecretsJson`). Fora do v4, o worker ainda importa o legado em 29 arquivos (motores v1/v2, `engine-choice.ts`), que é assunto da F10. **Capacidades que o v2 tem e o v4 não** (não são ponte, são ausência): falar com outros bots, rotinas, imagens, vídeo, GitHub e cofre (testes `computer-use.{bot-messaging,image-generation,github,vault,video-transcript,routine-page}.test.ts`). Decisão do escopo da F9 com o dono.
- [ ] F9.2 Capacidades do legado que faltam no v4 (dimensionamento de 09/11, em frentes de 1 agente; ordem custo × importância):
  - [ ] Rotinas: listar, controlar e agrupar; depois propor/editar, gatilhos e alerta (2; alta).
  - [x] Cofre (09/11): `secret_list`, `secret_request`, `login_fill` e `{{secret:NOME}}` no executor; cripto em `@workspace/db/vault-crypto`. **Decisão do dono (09/11) sobre login:** no chat, `login_fill` pede aprovação a cada uso; em rotina, ao CRIAR a rotina o bot vê se ela precisa de login e manda um cartão "posso usar o login X para entrar em Y nesta rotina?"; aprovado, a rotina guarda essa permissão e usa o login sozinha só quando o site bate. Cuidado pedido: o site é o mesmo mas o bot não acha o item do cofre: o `login_fill` deve achar o login pelo site da página (normalizando `www.`, caminho e barra), não só pelo nome que o modelo chuta. Implementar com a frente de Rotinas. **Decisão do dono (09/11), login com campos decididos pela IA:** nada de campos fixos (usuário/senha). O modelo vê a página e DECLARA os campos que ela pede (ex.: e-mail; depois senha; ou nome, CPF e senha), e o cartão de pedido mostra um campo de digitar para cada um. Tudo na mesma página = um cartão com todos; login em etapas = um cartão por etapa. Todas as etapas se juntam NUM item só do cofre (o login daquele site, com os campos dele), nunca um segredo solto por campo. No `login_fill`, o modelo diz qual campo salvo vai em qual campo da página; o valor só trafega worker→VM. Frente própria na onda 3 ("Cofre: login com campos dinâmicos").
  - [x] Painéis (09/11): `panel_list/read/update/share/unshare` na capacidade `deliverables`. Grupos (#171), fontes (#172); painel atualizado por rotina vai com Rotinas.
  - [x] Imagem (09/11): capacidade `images`, mesmo evento `images` (baralho no chat), gerar tudo antes de comentar. Custo no teto: #173.
  - [ ] GitHub leitura: `list_repos` e `compare`, movendo `agent-runtime/src/github/` para pacote (1; média).
  - [ ] Vídeo: transcrição por `kind` novo no `Sandbox` (1; média; depende de yt-dlp na imagem da VM).
  - [ ] Bots: `send_to_bot`, `decide_bot_pending`, `set_primary_bot` (1; média).
  - [ ] GitHub escrita com identidade do App e gatilhos (1; pode ficar depois).
  - [ ] Anexos: `attachment_read`, `attachment_list`, `attachment_to_computer` (1).
  - [ ] Proativo: `suggest_routine`, `notify_user` e alerta com veredito (`report_alert`) (1; junto das rotinas).
  - [ ] Habilidades (skills): propor, listar, mostrar e usar (1).
  - [ ] Subagentes: `delegate_task` além do `research` (2).
  - [ ] PR e CI das sessões de código (2 a 3; depende do GitHub escrita).
  - **Decisão do dono (09/11): todas entram na F9** ("quero que entre todas que já existem"). Ordem por ondas de até 3 agentes; auditoria Sonnet (com dúvidas) + validação Opus a cada duas ondas.
- [ ] F9.3 Desacoplar os 5 adaptadores do worker do `@workspace/agent-runtime` (calendar, email, mcp, code-actions-real, payment).
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

- **06/11/2026 · sessão de cards do app · F2.6 (parte do app, B6)**
  - **Feito:** branch `feat/harness-v4-cards-app` (a partir de `feat/harness-v4-f2-capacidades`), só `apps/web`. Os 4 eventos do v4 viram cards no chat (aprovação, "isso é com você", pergunta, recibo), com restauração dos eventos do run vivo, dedupe ao vivo × gravado e testes. Auditoria independente (Sonnet) feita; 5 achados corrigidos.
  - **Pela metade (fora de `apps/web`):**
    - rota `POST /v1/runs/:runId/cards/respond` (api) e a retomada com o grant; o app só chama `respondToAgentCard` em `lib/atlas-api.ts`;
    - o worker gravar os cards na conversa (`role` = tipo do evento, `content` = evento em JSON). Sem isso, o recibo de run encerrado some ao recarregar, e o card gravado de outro aparelho não sabe que já foi resolvido;
    - campo do código de segurança do cartão (F6.3), hoje só o espaço.
  - **Como verificar:** `cd apps/web && pnpm test`, `pnpm exec turbo typecheck` e as prévias com `AGENT_CARDS_PREVIEW_DIR=<pasta> pnpm e2e agent-cards-previews`.

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

- **08/11/2026 · sessão F7-W · cards genéricos do agente no web e no celular (branch `wip/f7-w`)**
  - **Feito:** merge de `feat/harness-v4-cards-app` (11 commits da outra conta, sem reescrever) com a F6, por união. O web agora chama as rotas reais (`/v1/agent-v4/runs/:runId/requests/:key/respond` e `/v1/agent-v4/cards/:cardId/respond`; a rota inexistente `/v1/runs/:id/cards/respond` saiu). O pedido do `checkout` (`ownerInput: card_cvv`) no fio vira o card de compra com o campo do CVV (`PurchaseApprovalCard`), com `inputOnly` só com o campo. A resposta digitada à pergunta do bot segue como fala depois de o servidor marcar o card. O handoff perdeu o "Agora não" (a API só aceita `handoff_done`). `agentCardKey` e `purchaseRequestFromEvent` foram para `packages/shared`. Celular: cards ao vivo e gravados, resposta pelas mesmas rotas, CVV (`secureTextEntry`, `number-pad`, `oneTimeCode`, valor só numa ref, apagado antes da chamada).
  - **Pendente:** o worker ainda não grava os cards v4 como mensagens da conversa (`role` = tipo do evento): o web restaura pelos eventos do run, o celular só de run ativo ou parado esperando, então recibo de run encerrado some ao recarregar no celular. Decisão local só em memória no celular (web: localStorage). Handoff sem "Agora não" até a API ter essa decisão. Prévias do celular nativo não foram geradas (só web em Chromium).
  - **Como verificar:** `pnpm exec turbo typecheck`; `pnpm --filter @workspace/shared test`; `cd apps/web && pnpm test`; `cd apps/mobile && pnpm test`; prévias: `AGENT_CARDS_PREVIEW_DIR=<pasta> AGENT_CARDS_CHROMIUM_PATH=<chrome> pnpm e2e e2e/agent-cards-previews.spec.ts`.

- **08/11/2026 · sessão F7 · correções da auditoria (branch `feat/harness-v4-f7-email-dia`)**
  - **Feito:** os 15 achados da auditoria de `5b9c3ca2`, um commit por achado com teste (`b56a6524` a `0f1d835a`), relatório em `auditorias/F7.md`. Gancho novo `enrichRiskFacts` nas tools (o cartão de aprovação lê o evento antes de pedir); `riskFacts.event` e `riskFacts.message` estruturados, com o texto montado no front.
  - **Pela metade:** reauditoria das correções (nada começou).
  - **Próximo passo:** rodar um auditor novo (Sonnet, só leitura) sobre `git diff 5b9c3ca2..HEAD`, corrigir o que achar, fechar `auditorias/F7.md`, abrir o PR contra `harness/v4` (issue #159) e, com a verificação verde, juntar.
  - **Como verificar:** receita da issue #159 (`pnpm exec turbo typecheck`; suítes shared, agent, web, mobile; api e worker com `tsx --test`; db com Postgres real).
  - **Dúvidas para o dono:** nenhuma.

- **08/11/2026 · sessão F7 · reauditoria fechada**
  - **Feito:** N1 a N6 corrigidos, um commit cada (`dca3a881` a `e0f9bff3`); N7 e N8 aceitos. `auditorias/F7.md` fechado.
  - **Próximo passo:** abrir o PR `feat/harness-v4-f7-email-dia` contra `harness/v4` e juntar com a verificação verde.

- **09/11/2026 · sessão F8 · integração das frentes A, B e C**
  - **Feito:** merges de `wip/f8-a`, `wip/f8-c` e `wip/f8-b` em `feat/harness-v4-f8-navegador-codigo`; adaptador `Sandbox` despacha `card_fill`, `browser.*` e `code.*`; `browser: true` quando a VM existe; `code` opt-in por `policyJson.codeMode` com `applyPolicyPreset`; `rootIsWorkspace` informado pelo adaptador. Verificação: typecheck 18/18, shared 3036, agent 901, agent-runtime 4054, sandbox 214, evals 327, queue 17, ui 123, web 1790, mobile 469, control server 346, worker 838, api 971, db 728 e `*.db.test` da api 5 (Postgres real).
  - **Próximo passo:** previews, auditoria independente (`auditorias/F8.md`), PR contra `harness/v4`. Faltam a tool/tela para o bot ligar o modo de código, o ok do dono para o `browser-bench` real e a prova ponta a ponta com Docker.
  - **Dúvidas para o dono:** nenhuma.

- **09/11/2026 · sessão F8 · correção dos achados da auditoria**
  - **Feito:** 15 achados corrigidos com teste (detalhe em `auditorias/F8.md`): cartão ilegível após o `card_fill`, egress por proxy local que valida o IP resolvido, envio de formulário de SPA, corrida e idempotência durável do pagamento, recusa por sinal estrutural, https e quadros confiáveis, botão de pagar estrutural, tool `settings_set_code_mode`, leituras de segredo no código, navegador só leitura sem dono, `PidsLimit`, saída longa redigida, segredos duráveis, limpeza de exports. Merge de `wip/f8-b` (bench real) e `pickWinner` com `tie`.
  - **Próximo passo:** reauditoria independente (Sonnet, só leitura), previews, PR contra `harness/v4`.
  - **Pendências:** token por sessão no control server; tela para ligar o modo de código; rodada extra do bench (T7 e T10) só com ok do dono; prova ponta a ponta com Docker.
  - **Dúvidas para o dono:** nenhuma.

- **09/11/2026 · sessão F8 · reauditoria e fechamento**
  - **Feito:** reauditoria em duas leituras Sonnet só leitura (VM; agente/worker), com a skill de segurança da Cloudflare em modo guia, trazendo também dúvidas; validação de cada item alto/médio e dúvida por uma leitura Opus (provas locais). 14 correções com teste: token por container no control server; proxy que não cai com status inválido; `git grep -O` e comandos que escrevem saem de "leitura"; leitura de segredo por glob e `$()`; Enter/Espaço/clique dentro do botão de envio exigem `submit`; digitar texto conta como saída (`egressForArgs`); `card_fill` só dá pago com sinal estrutural, 402 só da loja, limpa o cartão em todo retorno, formulário com vários envios falha antes de clicar; teto de saída do `code_shell` no worker; comando inteiro no cartão; cartões do modo de código em pt-BR; comentário honesto do `--no-sandbox`.
  - **Próximo passo:** PR para `harness/v4` e merge; depois F9.1 (inventário das pontes) e decidir o escopo com o dono (orçamento).
  - **Pendências:** ver "Adiados" em `auditorias/F8.md` (viraram issues); imagem da VM precisa ser reconstruída (token, `/card-fill`, `/browser/v4`); prova ponta a ponta com Docker e loja real; regra de rede no host contra DNS rebinding; PR/push do `code` pelo conector GitHub.
  - **Dúvidas para o dono:** nenhuma.
