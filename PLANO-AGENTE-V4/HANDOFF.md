# Handoff do Motor v4 (Atlas): onde paramos e o que falta

Documento para continuar o trabalho noutra conta ou sessão. Escrito em 09/11/2026.

Repositório: `ali-ali18/Atlas`.

## 1. Como trabalhar (vale para qualquer agente)

**Regras do repositório:**
- Antes de tudo, leia `CLAUDE.md`, `AGENTS.md` e `.agents/rules/*`.
- Leia o plano: `PLANO-AGENTE-V4/` (`05-fases.md`, `PROGRESSO.md`, `03-arquitetura.md`, `06-contrato-de-comportamento.md`, `auditorias/`).
- A fonte da verdade do andamento é `PLANO-AGENTE-V4/PROGRESSO.md`.
- Fale com o dono em pt-BR simples, sem despejo técnico.

**Branches e merge:**
- A integração vai no `harness/v4`. O dono autorizou o merge nele quando a fase está completa e segura.
- A `main` só recebe merge com o ok explícito do dono.
- Uma fase tem branch `feat/harness-v4-fN-*`. As frentes paralelas usam `wip/fN-*`.
- **Nunca reescreva histórico.** Nada de reset, rebase ou force push: o classificador bloqueia.
- Faça **push normal depois de cada etapa**, porque a cota pode acabar no meio.

**Commits:**
- Atômicos, em pt-BR (Conventional Commits), com o teste no mesmo commit.
- Staging explícito, nunca `git add -A`.

**Fluxo de cada fase:**
1. Frentes em paralelo, até 3 subagentes Sonnet.
2. Integração.
3. Verificação completa.
4. Prévias (tema escuro, desktop 1440 e celular 390).
5. **Auditoria independente**: agente novo, Sonnet, somente leitura, que recebe só o pedido e o diff.
6. Correções com teste.
7. **Reauditoria**.
8. `auditorias/FN.md` fechado; PROGRESSO e CHANGELOG atualizados.
9. PR para `harness/v4` e merge.

**Decisões fixas do dono:**
- Nada de regex para decidir comportamento: a decisão vem de sinal estrutural ou de campo declarado pelo modelo.
- Nunca reescrever o que o modelo escreveu.
- Nada de cortes para economia.
- Tools honestas.
- Escopo por dono: recurso de outro dono responde 404 ou "not found".
- Migrations só aditivas.
- Contexto lazy: "Bom dia" continua pequeno.
- Agent-first: tudo o que a UI faz, o bot faz pelo chat.
- Agenda sem horário de silêncio.
- CVV nunca é guardado nem chega ao bot.
- Modelos: Sonnet para o chat, Haiku para ajudantes, sono e plano do dia, Opus para código.

**Orçamento de modelo real:**
- Teto do dono: US$ 10. Gasto até agora: cerca de US$ 3,34 (US$ 3,26 antes da F8 e US$ 0,08 nas duas rodadas do bench da F8).
- **Nunca rode eval ou bench real sem o ok do dono.** Mostre a estimativa antes.
- A chave da Anthropic está na variável de ambiente `CLAUDE_KEY`. Não imprima nem grave a chave.
- Nos testes, remova as chaves: `env -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY -u OPENAI_API_KEY -u CLAUDE_KEY`.

## 2. Receita de verificação

1. `pnpm install` e depois `pnpm --filter @workspace/db exec prisma generate`.
2. `pnpm exec tsc` nos pacotes importados por `dist`: shared, observability, files, llm, search, queue, sandbox, mail, db, agent e agent-runtime.
3. `pnpm exec turbo typecheck`.
4. `pnpm --filter @workspace/<pkg> test` para shared, agent, agent-runtime, sandbox, evals, queue, ui, web e mobile.
5. Control server da VM: `node --test docker/agent-sandbox/control/*.test.mjs`.
6. api e worker:
   ```
   NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper ATLAS_OWNER_EMAIL=dono@exemplo.test BETTER_AUTH_SECRET=test-secret-test-secret-test-secret ATLAS_URL=http://localhost:3000 pnpm exec tsx --test "src/**/*.test.ts"
   ```
7. db com Postgres real. Use `/tmp`, porque o usuário postgres não acessa o scratchpad:
   ```
   D=/tmp/atlas-pg-X; mkdir -p $D; chown postgres $D
   su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $D/data -A trust -U postgres && /usr/lib/postgresql/16/bin/pg_ctl -D $D/data -o '-p 544XX -k $D' -l $D/log start"
   ```
   - Crie o banco `atlas_test` com `create extension vector`.
   - Aponte `DATABASE_URL` e `ATLAS_TEST_DB_URL` para `postgresql://postgres@127.0.0.1:544XX/atlas_test`.
   - Rode `prisma migrate deploy`.
   - Rode `pnpm test` no db com `ATLAS_HOOK_PEPPER=test-pepper`, e também os `*.db.test.ts` da api.
   - No fim, pare o Postgres e apague a pasta.
8. Evals: só com `--simulate`.
9. Prévias: Playwright com o Chromium em `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`. As imagens vão para `apps/web/e2e/__previews__/`, que o git ignora.
10. Um processo pesado por vez: `flock /tmp/atlas-heavy.lock <cmd>`.
11. Docker: se o daemon não estiver de pé, rode `dockerd &`. Para build da imagem da VM atrás do proxy, use uma cópia do contexto que instale a CA do proxy e `--network host`.

## 3. Estado atual

### Fases concluídas e mergeadas no `harness/v4`
F0 a F7. O `harness/v4` está em `41598145`.
- **F6, compras:** PR #158. Produto com card completo vindo da web, compra registrada com vigia de entrega, cartão salvo sem CVV, checkout com CVV no card de aprovação e mandato.
- **F7:** PR #164. E-mail (Gmail do dono e caixa do bot), calendário, plano do dia e os cards de aprovação genéricos no web e no celular.

### F8 em andamento: navegador, pagamento real (`card_fill`) e código
Issue-mãe **#165**; sub-issues **#168** (frente A: VM e `card_fill`), **#167** (frente B: browser) e **#166** (frente C: code).

Branches no remoto:

| Branch | HEAD | Conteúdo |
|---|---|---|
| `feat/harness-v4-f8-navegador-codigo` | `6345ba2a` | Integração A+B+C, já com parte das correções da auditoria. |
| `wip/f8-a` | `b7e3855e` | Pronta. |
| `wip/f8-b` | `d666d181` | Pronta. Também tem o bench real (as duas rodadas) e o relatório `docs/ops/browser-bench-f8.md`. |
| `wip/f8-c` | `c3bc670a` | Pronta. |

**Estava rodando quando esta conta parou** (pode ter sido salvo em parte; confira o remoto):
1. **Correções da auditoria F8**, no branch de integração.
   - Feitas, em 7 ou mais commits: dados do cartão, egress, submit, corrida, idempotência, iframe/https, botão pagar e outros. Confira com `git log 71d41055..origin/feat/harness-v4-f8-navegador-codigo`.
   - Faltavam, pela lista da auditoria abaixo: itens 12 e 13 (saída longa do shell fora do repo e redigida; segredos da sessão antes do clone) e os segredos duráveis por sessão em `code-actions`. Talvez também o 14 (custo e limpeza do `browser_digest`/`export`) e o 15 (testes).
   - Faltavam também: merge de `origin/wip/f8-b` no branch de integração, correção do `pickWinner` do bench para devolver `tie` em empate (fica o atual, porque custo não desempata), `auditorias/F8.md`, CHANGELOG, PROGRESSO, verificação completa, push e comentário na #165.
2. **Bench real concluído** (`wip/f8-b` em `d666d181`, relatório `docs/ops/browser-bench-f8.md`, comentário na #167). **Fica o navegador atual (ADR 0005)**: 9/9 contra 6/9 do `agent-browser` 0.41.2 nas tarefas T11, T7 e T10. O `agent-browser` errou as 3 do canvas (T10), porque não dá imagem ao modelo. Custo total do bench: US$ 0,08. O commit `d666d181` também precisa entrar no branch de integração junto com o merge de `origin/wip/f8-b`.

### Achados da auditoria F8 (commit `71d41055`): a lista que guia as correções
1. **Dados do cartão legíveis depois do `card_fill`.** Campos `cc-*` passam a ser secretos no inpage, `clearCard` roda no challenge, e o screenshot é recusado com cartão preenchido.
2. **Egress na camada de rede.** Proxy local que valida o IP já resolvido, cobrindo DNS rebinding, WebSocket e Service Worker. Remover `file:` e `ftp:`.
3. **Submit estrutural.** `browser_act` com "browse" submetia formulário de SPA. Qualquer submit dentro de `<form>` e Enter em campo de form exigem `intent: submit`.
4. **Corrida no `card_fill`.** Marcar in-flight de forma síncrona.
5. **Trava anti-repetição.** Tirar a regex de "declined", guardar a idempotência durável por `approvalId` no worker/db e montar a chave sem URL.
6. **Onde o cartão é digitado.** Só https, só no frame da loja ou de gateway conhecido; com vários candidatos, `failed`.
7. **Botão pagar.** Usar o submit do formulário do cartão e comparar o valor do rótulo com o total.
8. **Tool agent-first `settings_set_code_mode`** (off, plan ou build).
9. **Leitura de segredo pelo `code`.** `code_diff` em `.env`, `git show rev:path`, `env`, `/proc/*/environ` e caminho absoluto passam a exigir o dono.
10. **Navegador sem dono.** O `readOnly` deriva de "sem dono presente", não só de agenda.
11. **Container da VM.** `PidsLimit` e `CapDrop` em VM existente; o control server escuta em loopback ou exige token.
12. **Saída longa do shell.** Gravar fora do repo e redigida.
13. **Segredos antes do clone.** Preencher `known.secrets` antes do clone.
14. **Custo dos ajudantes.** `browser_digest` conta no teto de gasto, e os exports antigos são limpos.
15. **Testes** que provam o que dizem (egress real, concorrência, http, form SPA).

### Para fechar a F8
1. Confirmar o que já está no remoto e terminar os itens que faltam acima.
2. Fazer o merge de `origin/wip/f8-b` e corrigir o `pickWinner`.
3. Fazer a reauditoria (Sonnet, só leitura) do delta `71d41055..HEAD`, corrigir os achados novos e fechar `auditorias/F8.md`.
4. Atualizar o PROGRESSO: marcar F8.0, F8.1, F8.1a, F8.1b e F8.2; a F8.3 (Code Mode) é opcional e pode ficar em aberto, anotada.
5. Abrir o PR `feat/harness-v4-f8-navegador-codigo` para `harness/v4`, fazer o merge e fechar #165 a #168.

**Pendências conhecidas da F8 (anotar no PR):**
- Prova ponta a ponta com Docker e loja real.
- Regra de rede no host contra DNS rebinding.
- A imagem da VM precisa ser reconstruída para ter `/card-fill` e `/browser/v4`.
- PR e push do `code` vão pelo conector GitHub, que ainda não foi feito.
- Lista virtualizada no navegador fica "stalled" e não tem teste.

## 4. O que falta depois da F8 para fechar o motor

### F9: zerar a ponte com o motor antigo
1. Inventário das tools que o v4 ainda serve pelo legado: bots (falar com outros bots), rotinas, imagens, vídeo, GitHub, cofre etc. Anotar a contagem no PROGRESSO.
2. Uma versão nativa para cada uma (capacidade, porta, adaptador e testes, no molde das capacidades `shopping` e `email`) e apagar a ponte. A catraca (`guards/legacy-bridge-ratchet`) precisa chegar a 0.
3. Auditoria, correções, reauditoria e `auditorias/F9.md`.

### Pendências obrigatórias antes de ligar (issue #163 e outras)
- Persistir os cards v4 (aprovação, handoff, pergunta e recibo) como mensagens da conversa. Hoje, no celular, o recibo some ao recarregar.
- Pagamento testado ponta a ponta em loja real, e a regra de rede contra DNS rebinding.
- Menos urgentes:
  - ingestão do Gmail (push ou polling) para o gatilho "quando chegar e-mail";
  - cards `product` e `purchase` no celular;
  - tela e tool do mandato de compra;
  - nome técnico `CONNECTOR_ENCRYPTION_KEY` que aparece em telas (cofre, provider-keys, composio, marketplace);
  - "Agora não" no handoff (a API deve aceitar a dispensa);
  - i18n do app do celular.
- F0.1b: trocar os 17 cenários `real-pendente` por runs reais redigidos. Depende de acesso ao banco de produção.

### F10: corte e limpeza
1. **Critério de corte** (`PLANO-AGENTE-V4/04-avaliacao.md` §5), com a matriz real. **Gasta orçamento: estimar antes e pedir o ok do dono.**
   - Segurança: zero violações.
   - Conclusão: v4 ≥ v3 em toda capacidade, e +15 pontos nos modelos baratos.
   - Rubrica: +1 ponto em Entregáveis, Pesquisa e E-mail.
   - Agenda: 100% dos itens "agendar sozinho" criados.
   - Custo: "Bom dia" ≤ v3 + 15%, e custo médio por tarefa ≤ v2.
2. **Piloto de 7 dias** na conta do dono, com `harness.*` ≤ 5% dos runs.
3. **v4 vira padrão**; o v2 fica como emergência por 2 versões.
4. **Remover** v1, v2 e v3, mais `computer-use.ts` e o `agent-runtime` que só o legado usa. O worker deixa de importar `agent-runtime`.
5. **Documentação final:** ADR `0006-motor-v4-base-nova.md` e `docs/features/motor-v4.md`.
6. **Auditoria, reauditoria** e `auditorias/F10.md`.
7. **Merge na `main`**, só com o ok do dono: PR `release/<versão>` para `main`.

## 5. Ordem sugerida
1. Fechar a F8.
2. F9.
3. Pendências obrigatórias.
4. Matriz real de corte, com o ok de custo.
5. Piloto de 7 dias.
6. F10.
