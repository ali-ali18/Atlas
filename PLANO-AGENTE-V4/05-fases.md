# Fases do Motor v4

## Regras
- Ramo de integração: `harness/v4`, a partir do ramo da versão.
- Um PR por fase, ou por sub-PR, contra `harness/v4`.
- Branch: `feat/harness-v4-<fase>`.
- Cada PR segue as regras de `.agents/rules/`:
  - testes no mesmo commit;
  - `turbo typecheck` verde;
  - CHANGELOG atualizado;
  - auditoria independente (Sonnet, só leitura);
  - prévias quando muda tela.
- Liga só por flag: `ATLAS_ENGINE_V4` + `ATLAS_ENGINE_V4_ACCOUNTS`, no `chooseRunEngine`.
- **Teste de guarda contra regex** (F1): falha se `engine-v4/**` ou `capabilities/**` usar `RegExp`, `.match(`, `.test(` ou `includes(` sobre:
  - `objective`;
  - conteúdo de mensagem;
  - texto do assistente.

  A guarda trabalha por análise de AST com allowlist de identificadores. Exceções só para validação de formato (id, URL, nome de pacote), com comentário.

## Ordem
```
F0 baseline ─► F1 núcleo ─┬─► F2 entregáveis ─► F3 pesquisa ─┐
                          ├─► F4 agenda ────────► F6 compras ─┼─► F9 corte
                          ├─► F5 memória/caderno/sono ────────┤
                          ├─► F7 e-mail/dia ──────────────────┤
                          └─► F8 código + navegador ──────────┘
```
- F2 a F8 são independentes depois da F1. Podem andar em paralelo, até 3 agentes.
- F6 depende da F4 (vigia de entrega).

---

## F0: Baseline medido (antes de qualquer código do v4)
**Objetivo:** saber onde v2 e v3 erram hoje, por capacidade e por modelo.
- [ ] Conjunto ouro: 24 tarefas (`04` §1), sendo pelo menos 12 de runs reais via `from-run.ts`.
- [ ] Comando `matrix` no CLI de evals, com relatório Markdown e JSON.
- [ ] `classifyRunFailure` em shared, puro e com testes por classe.
- [ ] Rodar o baseline com o preset `minimal` (simulado sobre o v3 sem extras) e com os motores v2 e v3. O número fica no PR.

**Arquivos:**
- `packages/evals/tasks/**`
- `packages/evals/src/matrix/*`
- `packages/shared/src/run-failure-class.ts`

**Pronto:** relatório baseline commitado em `docs/ops/v4-baseline.md`.

## F1: Núcleo v4
- [ ] Mover o laço do v3 para `engine-v4/kernel/`. O v3 vira alias do kernel com preset `v3`, para o eval.
- [ ] `defineCapability`, o registro e `use_capability`, com contexto só de acréscimo.
- [ ] Ganchos tipados (`beforeTool`, `afterTool`, `onRunEnd`, `onWake`), sem acesso ao texto do assistente.
- [ ] Canais: `<atlas:runtime id>` com nonce, `<data trust="untrusted">` e escape determinístico.
- [ ] Tirar as decisões por texto do v3:
  - `isBotConfigEventObjective` passa a usar `RunInput.kind`;
  - `looksLikeEngineRequest` sai;
  - `open_list` vira dado no resultado da `update_task_list`;
  - texto vazio vira evento de status.
- [ ] Contrato de trabalho (`03` §3), com teste de string por seção.
- [ ] Política: regras como dado em `policyJson.rules`, `riskFacts`, anotações MCP e classificação de schema em cache, fail-closed.
- [ ] Teste de guarda contra regex.

**Testes:**
- Replay de "Bom dia" (economia).
- Injeção forjando `<atlas:runtime>` em e-mail e em fala do usuário.
- Política: matriz de efeito × origem × autonomia.
- `money` sem humano fica escondido.
- MCP sem anotação é tratado como `write_external`.

**Riscos:**
- Checkpoints do v3 em andamento: a migração é só leitura de formato, com o teste `checkpoint.v3→v4`.
- Cache: o prefixo precisa ficar estável. Medido no mock.

## F2: Entregáveis (documentos, slides, planilhas, painéis)
- [ ] Capacidade `deliverables` com `core: true`: `create_file`, `create_page`, `inspect_file`.
  - `inspect_file` renderiza e devolve as páginas como imagem ou texto, para o modelo conferir.
- [ ] `skill.md` com os moldes:
  - trabalho acadêmico ABNT (`files/abnt*` já existe);
  - relatório;
  - deck (`files/deck`);
  - planilha com fórmulas.
- [ ] Fontes e "não confirmado" continuam anexados pelo runtime **ao arquivo**, nunca à resposta.

**Eval:** tarefas de Entregáveis com rubrica (estrutura, normas, conteúdo, visual) e arquivo válido (abre, número de páginas).

## F3: Pesquisa profunda
- [ ] Capacidade `research`:
  - porta o caderno de trabalho e os ajudantes (`delegate`) do v2 (`engine-v2/notebook.ts`, `helpers.ts`), com contexto descartável e retorno só do resultado;
  - planeja as perguntas;
  - roda os ajudantes em paralelo;
  - consolida no caderno com fonte por afirmação.
- [ ] O resultado sai no formato certo (resposta, tabela, painel ou arquivo), segundo o contrato.

**Eval:** 10 fornecedores; contradição entre fontes; citações verificáveis (o check abre a URL no mock).

## F4: Agenda do agente
- [ ] Migration aditiva em `BotFollowup` (`03` §7).
- [ ] Funções puras em shared: `planAgendaItem`, `nextWatchDelay`, `matchEventFilter`.
- [ ] Tools `remind_me`, `watch`, `on_event` e `agenda_result`, com `core: true` para `remind_me` e `watch`.
- [ ] Worker: wake → run `agenda`; `no_change` não posta; `done` encerra.
- [ ] Seção "Agenda" na Biblioteca, com cancelar e pausar.
- [ ] `schedule_return` do v3 vira um `remind` (o mesmo caminho).

**Testes:**
- Escopo por dono: B não vê nem cancela a agenda de A.
- Espaçamento.
- Filtro de evento.
- Replay "acompanha o preço a cada 3h" cria um `watch`, e não uma rotina.

## F5: Memória em camadas, Caderno e Sono
- [ ] Model `Note` com rotas `/v1/notes` (escopo por dono, teste IDOR) e tools `note_write`, `note_search`, `note_read`.
- [ ] Biblioteca: seção "Caderno".
- [ ] `memory` sem juiz LLM no caminho quente.
- [ ] Job `sleep` (`03` §6):
  - propõe fatos, notas, skills e casos de eval;
  - aplica o critério estrutural;
  - registra em `MemoryChange`.
- [ ] Migração das lições (PR8c do v3) aplicada com o ok do dono. `confirm_always` vira regra de política.

**Eval:**
- Preferência dita numa conversa é usada na seguinte.
- Fato vindo de e-mail **não** vira memória.
- Duplicata é juntada.

## F6: Compras
- [ ] Capacidade `shopping`:
  - `product_search`: busca web com foco em loja e extração **estruturada** (JSON-LD `schema.org/Product`, OpenGraph), sem regex de preço no texto;
  - `product_card`: card novo em shared, com foto, nome, preço, loja, frete e link, além de comparação lado a lado.
- [ ] `checkout`, com efeito `money`, pelo navegador da VM:
  - `card_fill` preenche o cartão a partir do cofre, como o `login_fill`. **O número nunca entra no contexto, no log nem no evento.**
  - O cartão de aprovação mostra os `riskFacts`: loja, itens, total, frete e final do cartão.
- [ ] `record_purchase` grava um `Purchase` novo (loja, itens, total, pedido, rastreio). Gancho `afterTool` cria `watch` de entrega **sem pedir**, e encerra quando o status for "entregue".

**Segurança:**
- `money` sempre pede confirmação.
- `checkout` nunca roda em agenda nem em rotina.
- Teste de vazamento do cartão em log, SSE e `tool_result`.

## F7: E-mail de verdade e dia planejado
- [ ] Capacidade `email`:
  - lê o corpo, não só o assunto;
  - separa "precisa de ação", "só pra saber" e "ignorar" por campo declarado pelo modelo;
  - extrai prazo e quem pede.
- [ ] "Seu dia" passa a ser um item `brief` da agenda: e-mail, calendário, caderno, agenda e compras em andamento.

**Eval:** as tarefas de e-mail do conjunto ouro, incluindo "quando começa a prática de extensão?", em que a resposta precisa vir do corpo do e-mail.

## F8: Código e navegador
- [ ] Perfis `plan` (só leitura, mais um arquivo de plano) e `build`, como presets de política (OpenCode).
- [ ] Edição precisa: `str_replace` no sandbox e verificação por teste (`execution/dev-verification.ts`).
- [ ] Experimento Code Mode: o modelo escreve um script que chama tools, medido na matriz e ligado só se ganhar.
- [ ] Navegador v3 mantido, com o `browser-bench` rodando com modelo real na matriz.

## F9: Corte
- [ ] Critério de `04` §5 atendido, com o relatório no PR.
- [ ] Piloto de 7 dias na conta do dono.
- [ ] v4 vira padrão. O v2 fica como emergência por 2 versões e depois é removido junto com o v1, que ainda serve os subagentes. O v3 é absorvido.
- [ ] ADR `0006-motor-v4-nucleo-e-capacidades.md` e `docs/features/motor-v4.md`.
