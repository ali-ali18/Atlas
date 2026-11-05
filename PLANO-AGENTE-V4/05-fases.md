# Fases do Motor v4 (base nova)

## Regras
- Ramo de integração: `harness/v4`, a partir do ramo da versão. Um PR por fase ou sub-fase. Branch: `feat/harness-v4-<fase>`.
- Cada PR segue as regras de `.agents/rules/`:
  - testes no mesmo commit;
  - `turbo typecheck` verde;
  - CHANGELOG atualizado;
  - **auditoria de fase** com 5 lentes, verificação, correções confirmadas e reauditoria ([`auditorias/README.md`](auditorias/README.md)). Sem achado crítico ou alto aberto, a fase não vai para PR;
  - prévias quando muda tela.
- Flag: `ATLAS_ENGINE_V4` + `ATLAS_ENGINE_V4_ACCOUNTS`, no `chooseRunEngine`.
- **Guardas permanentes (entram na F1, nunca saem):**
  1. **Fronteira:** `packages/agent` não importa `@workspace/agent-runtime`.
  2. **Sem regex de comportamento:** análise de AST em `packages/agent/src/**`. Nada de `RegExp`, `.match`, `.test`, `.includes` ou `.startsWith` sobre `objective`, conteúdo de mensagem ou texto do assistente. Exceções só para validação de formato, com comentário.
  3. **Catraca da ponte:** a contagem de arquivos em `legacy-bridge/` só cai.
  4. **Invariantes do contrato:** os testes da coluna "Teste invariante" de `06`.
  5. **Economia:** "Bom dia" com teto de tokens de entrada.

## Ordem
```
F0 baseline ─► F1 fundação ─► F2 capacidades núcleo ─┬─► F3 pesquisa
                                                      ├─► F4 agenda ─► F6 compras
                                                      ├─► F5 memória/caderno/sono
                                                      ├─► F7 e-mail + dia
                                                      └─► F8 navegador/VM + código
                         F9 ponte → zero ─► F10 corte e remoção de v1/v2/v3
```
- Depois da F2, até 3 frentes em paralelo.
- A F9 anda o tempo todo: cada fase tira pontes.

---

## F0: Baseline medido
- [ ] Conjunto ouro de cerca de 24 tarefas reais (`04` §1), com pelo menos 12 vindas de runs reais via `from-run.ts`.
- [ ] `matrix` no CLI de evals (presets × modelos × repetições) e rubrica com juiz offline.
- [ ] `classifyRunFailure` puro em shared.
- [ ] Rodar com o v2 (o padrão de hoje) e com o v3 (o branch) para ter o "antes". Relatório em `docs/ops/v4-baseline.md`.

## F1: Fundação (pacote novo, contrato e núcleo)
- [ ] `packages/agent` com `ports/`, `kernel/`, `contract/`, `channels/` e `presets/`.
- [ ] `defineTool` com efeito obrigatório e `defineCapability` com registro, `use_capability` e índice.
- [ ] `decide()` puro em shared, com tokens de aprovação, mandatos, `HANDOFF_ACTIONS`, taint e `Receipt` (cláusulas 1, 2, 3, 6, 7, 8, 9 e 16).
- [ ] Canais com nonce e escape.
- [ ] Kernel:
  - estados;
  - checkpoint com journal;
  - compactação em 3 passos;
  - limites do dono;
  - passo final honesto;
  - eventos compatíveis com o contrato SSE.
- [ ] Sem corte por economia (`03` §2): compactação só por janela cheia e restaurável, leitura em partes no lugar de truncar, nenhum teto padrão de pesquisa. Teste invariante: nenhuma saída de tool é truncada sem um ponteiro para "ler o resto".
- [ ] Ciclo de vida da tarefa (`03` §2.1): sem herança entre runs, oferta por cartão com estado, `declinedOffers`, falha relatada encerra (cláusula 17). Replays de insistência no CI.
- [ ] Contrato de trabalho (prompt estável em inglês), com teste de string por seção.
- [ ] Porta `Llm` com papéis, cadeia de reserva entre provedores (`pickModelFor`, com testes de 429 e queda no meio do run) e tetos opcionais do dono.
- [ ] Worker: `chooseRunEngine` → `runAgent(runId, ports)`, atrás da flag.
- [ ] As 5 guardas permanentes.

**Teste de fumaça:** "Bom dia", uma busca web e um arquivo simples, com o preset `minimal`, ponta a ponta no worker com mock.

## F2: Capacidades do núcleo
- [ ] `web`: busca e extração, portando as funções puras para shared quando forem compartilhadas.
- [ ] `deliverables`: `create_file`, `create_page`, `chart` e `inspect_file`, com moldes ABNT, relatório, deck e planilha na skill.
  - Os renderizadores de `agent-runtime/src/files/*` **migram** para um pacote próprio, `packages/files`, que o v1 e o v2 também passam a importar.
  - Assim nada é duplicado, e a ponte não é necessária.
- [ ] `memory` (perfil), `tasks` (lista de tarefas) e `settings` (configurar o bot pelo chat, inclusive o modelo por papel).
- [ ] `connectors`: ponte MCP com `tool_search`, escopo por dono, `confirmWrites` virando regra de política e classificação de schema.

## F3: Pesquisa
- [ ] `research`: plano de perguntas, ajudantes em paralelo (o próprio kernel com preset filho e política que nunca concede mais que a mãe), caderno de trabalho com fonte por afirmação, saída no formato certo.

## F4: Agenda
- [ ] Migration aditiva em `BotFollowup`.
- [ ] Funções puras em shared: `planAgendaItem`, `nextWatchDelay`, `matchEventFilter`.
- [ ] Tools `remind_me`, `watch`, `on_event` e `agenda_result`. Worker de wake com contrato silencioso e freios.
- [ ] Seção "Agenda" na Biblioteca (cláusulas 10 e 13).

## F5: Memória, Caderno e Sono
- [ ] Model `Note`, rotas `/v1/notes` com teste IDOR, tools e seção "Caderno" na Biblioteca.
- [ ] Regras aprendidas visíveis e editáveis.
- [ ] Job `sleep` com critério estrutural, `MemoryChange` e "doctor" semanal (cláusula 14).

## F6: Compras
- [ ] `product_search` com extração estruturada (JSON-LD e OpenGraph) e card `product` (foto, preço, loja, frete, comparar).
- [ ] **Cartão salvo (decisão do dono):** número, nome, validade e endereço de cobrança no cofre (`secretsEnc`, escopo por dono, teste IDOR). **O CVV nunca é guardado.**
- [ ] `checkout` (`money`) pelo navegador da VM:
  1. O modelo monta o carrinho e chama `checkout`.
  2. O cartão de aprovação mostra loja, itens, total, frete e o final do cartão, e traz um **campo de CVV** (componente seguro, fora do chat).
  3. Ao confirmar, a API entrega o CVV direto para `card_fill`, que preenche o formulário de pagamento da loja na VM, junto com os dados do cofre, e o valor é descartado.
  4. Reserva: se a loja abrir 3DS, app do banco ou captcha, o run estaciona com "Assumir", e o dono termina no navegador da VM.
- [ ] Testes:
  - o CVV não aparece em evento SSE, journal, `tool_result`, log, checkpoint nem banco;
  - aprovação sem CVV não executa;
  - o CVV só vale para aquele token de aprovação.
- [ ] Mandato opcional (valor, loja, prazo, usos) para pular só o "confirmar"; o CVV continua sendo pedido.
- [ ] `record_purchase` grava um `Purchase` novo, e o gancho cria o vigia de entrega sozinho.

## F7: E-mail e dia
- [ ] `email` e `calendar`: lê o corpo, separa por campo declarado ("precisa de ação", "só pra saber", "ignorar"), extrai prazo e quem pede, e rascunha respostas para revisão. Envio é `send` com cartão.
- [ ] `brief` da agenda: plano do dia com e-mail, agenda, caderno, pendências e entregas.

## F8: Navegador/VM e código
- [ ] `browser`: reescreve as 4 tools com `page_state` (ideia do v3) sobre a porta `Sandbox`, e roda o `browser-bench` com modelo real.
- [ ] `code`: presets de política `plan` e `build`, edição precisa, verificação por teste e dev sessions.
- [ ] Experimento Code Mode, ligado só se ganhar na matriz.

## F9: Ponte → zero
- [ ] Cada tool ainda servida pelo legado (bots, rotinas, imagens, vídeo, GitHub, cofre etc.) ganha a sua versão nativa numa capacidade, e a ponte correspondente é apagada.
- [ ] A catraca chega a 0.

## F10: Corte e remoção
- [ ] O critério de corte de `04` §5 é atendido, e o piloto de 7 dias roda na conta do dono.
- [ ] O v4 vira padrão. O v2 fica como emergência por 2 versões.
- [ ] Remover `engine-v2/`, `computer-use.ts` e todo `packages/agent-runtime` que só o legado usa, mais o branch `harness/v3`, junto com os testes deles. O worker deixa de importar `agent-runtime`.
- [ ] ADR `0006-motor-v4-base-nova.md` e `docs/features/motor-v4.md`.
