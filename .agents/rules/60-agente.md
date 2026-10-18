---
description: Regras específicas do runtime do agente Atlas (prompt, tools, honestidade, UX de configuração)
globs: packages/agent-runtime/**,packages/shared/src/**,apps/worker/src/processors/**,apps/api/src/chat/**
alwaysApply: false
---

# Runtime do agente

## Tools
- Resultado honesto: sucesso → `summary` útil; falha → **lança erro** (`ok:false`) com a mensagem real e uma dica acionável. Nunca devolva texto de erro com `ok:true`.
- Nova tool: schema com descrição curta e **quando usar / quando não usar**, validação dos args no executor e testes (ver `50-testes.md`). Módulo próprio, não mais um bloco no `computer-use.ts`.
- Não mate o run por uma tool opcional: falha → dica e alternativa. As travas (limites, repetição, falhas seguidas) devolvem mensagem ao modelo antes de abortar.
- Tools de escrita (criar rotina, perfil, arquivo, evento) mostram card ou resultado visível ao usuário.

## Prompt
- Texto que vai para o **modelo** (system prompt, instruções injetadas, descrições de tools): **inglês**, curto, em seções. O idioma de resposta vem de `languageInstruction(bot.language)`.
- Texto que o **usuário** vê (erros amigáveis, cards, mensagens de trava): pt-BR, ou o idioma do bot quando gerado pelo modelo.
- Regra nova no prompt vem com um teste de string ou replay que a protege.
- Nada de proibições absolutas que contradizem capacidades (ex.: "GitHub nunca tem intervalo"). Descreva quando usar cada opção.

## Configuração agent-first
- O usuário configura conversando: o agente cria rotina, gatilho ou conector via tool, e a UI mostra um resumo em frase ("Uma vez · 03/10 às 10:00", "A cada 50 min"). Formulário só como fallback recolhido. Não exponha modos internos (polling, secrets, cron cru) na UI.
- Perfil do bot só muda no onboarding ou com pedido explícito. Preferência do usuário vai para `memory`.

## Conectores
- Com conector conectado, crie e edite recursos **pelo conector**, nunca pelo navegador do sandbox (conta diferente → 403 depois).
- Conexões são escopadas por dono (`ownerIds`). Nunca liste as de todos.
