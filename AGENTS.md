<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Regras do projeto (fonte única: `.agents/rules/`)

Todo agente (Claude, Cursor, GPT/Codex, Gemini…) segue estas regras. Leia as que valem para a sua tarefa **antes** de mudar código:

| Arquivo | Assunto | Sempre? |
|---|---|---|
| [`.agents/rules/00-core.md`](.agents/rules/00-core.md) | stack, pnpm, posse de arquivos, definição de pronto, idioma | sim |
| [`.agents/rules/10-git-worktree.md`](.agents/rules/10-git-worktree.md) | um worktree por agente, staging explícito, o que nunca fazer | sim |
| [`.agents/rules/20-commits.md`](.agents/rules/20-commits.md) | Conventional Commits em pt-BR, commits atômicos | sim |
| [`.agents/rules/30-componentizacao.md`](.agents/rules/30-componentizacao.md) | camadas, reuso, funções puras, UI com `packages/ui` | ao mexer em código |
| [`.agents/rules/35-componentes.md`](.agents/rules/35-componentes.md) | catálogo de componentes (ui, gráficos, painéis, cards do chat, telas) e quando usar | ao mexer em UI ou em cards |
| [`.agents/rules/40-seguranca.md`](.agents/rules/40-seguranca.md) | IDOR/escopo por usuário, segredos, entrada externa, webhooks | sim |
| [`.agents/rules/50-testes.md`](.agents/rules/50-testes.md) | o que testar e como rodar | sim |
| [`.agents/rules/60-agente.md`](.agents/rules/60-agente.md) | runtime do agente: tools honestas, prompt, agent-first | ao mexer no agente |
| [`.agents/rules/70-padroes-produto.md`](.agents/rules/70-padroes-produto.md) | decisões de produto e arquitetura: autonomia, contexto lazy, linguagem com o usuário, chat, UI, prévias e merge | sim |
| [`.agents/rules/80-fluxo-de-trabalho.md`](.agents/rules/80-fluxo-de-trabalho.md) | fluxo de toda feature: análise, plano, verificação, documentação, auditoria independente, entrega, custo dos agentes | sim |

`CLAUDE.md` (Claude Code) e `.cursor/rules/*.mdc` (Cursor) só apontam para esses arquivos. **Edite as regras em `.agents/rules/`**, nunca nas cópias.

# Delegação obrigatória para sub-agentes

> Vale para o agente **orquestrador**. Se você já é um subagente executando uma tarefa delegada, execute direto: não re-delegue em cadeia.

Sempre delegue via `Task` (`subagent_type: explore`) quando QUALQUER um for verdade:

1. 3+ arquivos para ler, ou destino desconhecido ("onde fica X?", "como funciona Y?")
2. Mudança toca 3+ arquivos ou >200 linhas estimadas
3. Tarefa tem 3+ passos independentes (pesquisa paralelizável)
4. Busca aberta (Grep/Glob precisaria de 2+ rodadas)
5. Tarefas com longo tempo de rodagem (ex: compilação, testes, deploy).

Como delegar:

- Lance 2-4 `Task` em paralelo numa única mensagem, um por área (ex: `apps/api/routes`, `packages/queue`, `packages/db`, `apps/web`).
- Prompt do agente deve dizer: só pesquisa ou codifica + como verificar + o que retornar.
- Não duplique o trabalho do agente, só integre o resultado.

Exceção: fix trivial em 1-2 arquivos já conhecidos = fazer direto, sem delegar.

Exemplos:

```text
# ❌ RUIM — ler tudo na mão
Grep "AgentRun" -> Read 6 arquivos -> Glob packages/** -> estoura contexto

# ✅ BOM — delega em paralelo
Task(explore: "onde AgentRun é enfileirado em apps/api?") +
Task(explore: "onde é processado em packages/?") +
Task(explore: "onde o status é persistido via @workspace/db?")
```

## Agent skills

### Issue tracker

Issues no GitHub Issues de `ali-ali18/agent-bot`, via CLI `gh`. Ver `docs/agents/issue-tracker.md`.

### Domain docs

Contexto único: `GLOSSARY.md` e `docs/adr/` na raiz. Ver `docs/agents/domain.md`.
