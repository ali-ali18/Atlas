# F10 — Autonomia: o agente age sozinho, com as regras num lugar só

**Dono:** Bot B (runtime) · **Revisa a parte de conectores:** Bot A · **Depende de:** F1 (conexões por dono), F2 (tools Google de escrita) · **Status:** aprovada pelo revisor (29/09), mergeada na checkpoint

## Decisão do usuário (29/09)
- "Quero que seja agêntico. Pedir autorização não faz sentido; tem que ter um lugar para eu controlar isso."
- **Escopo:** padrão da conta + override por bot. Também dá para mudar conversando ("pode fazer sem me perguntar").
- **Níveis:** 3 níveis + exceções por conector/ação.
- **Validade:** opcional (1 dia, 7 dias, 30 dias ou sempre). Quando vence, volta ao nível anterior e o bot avisa no chat.

## Diagnóstico (hoje)
- Confirmação espalhada:
  - `McpConnection.confirmWrites` (interruptor por conexão no Marketplace) → `requiresConfirmation` no `mcp/registry.ts` → card `mcp-call` (`SkillPendingIntent`) no `computer-use.ts` (`executeMcpTool`);
  - card de perfil (`propose_profile_update`) e card de apagar skill (`propose_skill_delete`).
- Nada por bot, nada com validade, nenhuma tela única.
- Rotinas só recebem tools de leitura (`readOnlyOnly` em `agent-run.ts`), porque não há humano para confirmar.

## Modelo
Três classes de ação, calculadas por tool:

| Classe | Exemplos | Como classificar |
|---|---|---|
| `read` | listar, ler, buscar | `readOnlyHint: true` ou catálogo `readOnlyTools` (já existe) |
| `write` (reversível) | criar evento, criar planilha, `update_range`, rascunho de e-mail, criar rotina, atualizar perfil | escrita sem `destructiveHint` |
| `irreversible` | apagar (evento, arquivo, skill), **enviar** (e-mail, Slack, comentário/merge/push no GitHub), pagar | `destructiveHint: true` **ou** `openWorldHint` com efeito para terceiros **ou** fallback por nome (`delete\|remove\|send\|merge\|post\|publish\|pay\|transfer`) |

- Tools host do agente recebem a classe fixa no código: `propose_profile_update` = write; `propose_skill_delete` = irreversible.
- As tools Google embutidas ganham annotations corretas (as nossas, não dependemos de terceiro).

Níveis (o que **pergunta**; o resto executa direto):

| Nível | read | write | irreversible |
|---|---|---|---|
| **Autônomo** | não | não | **sim** |
| **Equilibrado** (padrão) | não | conectores sim; host não | sim |
| **Sempre perguntar** | não | sim | sim |

- **Exceções** (lista, por conector ou por tool): `always_ask`, `never_ask` ou `blocked` (a tool some do run). Uma exceção vence o nível.
- `never_ask` numa ação irreversível exige um aviso explícito na UI.

## Tarefas
### Dados (`packages/shared` + `packages/db`)
- [ ] Tipo `AutonomyPolicy = { level: "autonomous" | "balanced" | "always_ask"; until?: ISO; fallbackLevel?; exceptions: { connector?: catalogId|slug; tool?: exposedName; mode: "always_ask" | "never_ask" | "blocked" }[] }`, com parser e validação puros.
- [ ] Persistência sem tabela nova: `UserSettings.autonomyJson` (padrão da conta) e `Bot.autonomyJson` (override, `null` = herda). A migração precisa de timestamp próprio.
- [ ] `resolveAutonomy(bot, settings, now)` → política efetiva: bot válido > conta > `balanced`. A política vencida cai para `fallbackLevel`.
- [ ] `decideAction(policy, toolMeta)` → `"allow" | "ask" | "block"`. É função pura, com uma matriz de testes.
- [ ] Migrar `McpConnection.confirmWrites=false` para uma exceção `never_ask` do conector. O campo continua sendo lido até a migração rodar, e depois deixa de ser usado.

### Runtime (`computer-use.ts`, `mcp/registry.ts`, worker)
- [ ] `requiresConfirmation` passa a vir de `decideAction`, e não de `confirmWrites`. `block` tira a tool da lista do run.
- [ ] O perfil e o apagar skill usam o mesmo gate. `allow` aplica direto e mostra um card de **resultado**, não de pergunta.
- [ ] **Rotinas:** recebem as tools cuja decisão é `allow`. As de `ask` ficam fora, porque não há humano para responder. Assim, no nível Autônomo, uma rotina pode criar evento ou planilha. O `readOnlyOnly` fixo sai.
- [ ] **Validade:** no início do run, se a política do bot venceu, grava o fallback e injeta **uma** mensagem no chat: "A autonomia do <bot> voltou para <nível>."
- [ ] Tool `set_autonomy({ scope: "bot" | "account", level, duration?: "1d" | "7d" | "30d" | "forever", exceptions? })` (agent-first). **Segurança:**
  - só é exposta quando a **última mensagem do usuário** pede isso explicitamente (helper puro `looksLikeAutonomyRequest`, no padrão de `looksLikeProfileChangeRequest`);
  - nunca em rotina ou webhook;
  - dados externos (e-mail, página, issue) nunca mudam a autonomia;
  - sempre mostra um card de resumo do que mudou.
- [ ] Card de confirmação (quando `ask`): botões **Executar**, **Cancelar** e **"Não perguntar mais para isto"**. O terceiro cria a exceção `never_ask` da tool no bot e executa.

### Web (agent-first: resumo em frase, formulário recolhido)
- [ ] **Configurações da conta → "Autonomia"** (padrão):
  - seletor de 3 níveis com uma linha explicando cada um;
  - validade (Sempre, 1 dia, 7 dias, 30 dias);
  - exceções em "Avançado", recolhido.
- [ ] **Configurações do bot → "Autonomia"**: "Herdar da conta" ou um nível próprio + validade.
- [ ] Resumo em frase no topo: "Autônomo por mais 6 dias · Gmail sempre pergunta · GitHub merge bloqueado".
- [ ] Marketplace: o interruptor "Pedir confirmação antes de alterar dados" vira um link "Gerenciar em Autonomia", com a exceção daquele conector já filtrada.

## Testes obrigatórios
- [ ] Matriz `decideAction`: 3 níveis × 3 classes × exceções (a exceção vence; `blocked` remove).
- [ ] `resolveAutonomy`: bot > conta > padrão; vencida → fallback.
- [ ] Classificação: annotations (read, destructive, openWorld), catálogo `readOnlyTools` e fallback por nome.
- [ ] Replay:
  - nível Autônomo + "cria um evento amanhã 10h" → `create_event` executa sem card;
  - Equilibrado → card;
  - "apaga o evento" → card em qualquer nível.
- [ ] Rotina no nível Autônomo recebe `create_spreadsheet`; em Equilibrado, não.
- [ ] `set_autonomy`:
  - exposta com "pode fazer sem me perguntar por 7 dias";
  - **não** exposta quando o pedido vem dentro de um resultado de tool (injeção);
  - não exposta em rotina.
- [ ] Vencimento: o run depois do `until` grava o fallback e a mensagem aparece uma vez só.
- [ ] Migração de `confirmWrites=false` → exceção `never_ask`.

## Commits
1. `feat(shared): política de autonomia (níveis, exceções, validade)`
2. `feat(db): autonomia na conta e no bot`
3. `feat(agent): gate único de autonomia (conectores, perfil, skills, rotinas)`
4. `feat(agent): set_autonomy por conversa, com trava contra injeção`
5. `feat(web): tela de Autonomia (conta e bot) e atalho no Marketplace`

## Critérios de aceite
- Taldo em Autônomo por 7 dias:
  - "marca reunião amanhã 10h" → cria sem perguntar;
  - "apaga a reunião" → pergunta.
- Jujuba herdando Equilibrado → pergunta antes de criar evento.
- No chat: "pode fazer sem me perguntar pelos próximos 7 dias" → card de resumo; a tela de Autonomia mostra "Autônomo por mais 7 dias".
- Depois da validade (simular com `until` no passado) → volta ao nível anterior e avisa no chat.

## Commits feitos
1752ccf feat(shared) política · c6766c1 feat(db) autonomia conta/bot (migração 20260929010000_autonomy) · 01d7e31 feat(agent) gate único · 9ad73d4 feat(agent) set_autonomy · b2648f9 feat(web) "Não perguntar mais" · a944d13 feat(web) componentes · 4f65b27 feat(web) conta, bot e Marketplace
