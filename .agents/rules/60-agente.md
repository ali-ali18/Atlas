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

## Decisão de comportamento: sem regex
- **Decisão de comportamento do agente (parar, promover, entregar, portão) não usa regex sobre texto do usuário ou do modelo.** Usa **sinal estrutural** (lista de tarefas, tools chamadas, estado do run, configuração) ou **campo declarado pelo modelo numa tool** (ex.: `deliverable: "document" | "answer"` na `update_task_list`). Regex só para coisa determinística (validar nome de pacote, id, formato).
- Motivo: texto é ambíguo. "compare" virou "pedido de documento", "vou pedir..." virou "promessa", "continua" virou "continuação" e o bot parou com uma nota falsa de teto de gasto (decisão do dono, 03/11).
- Texto que o modelo **já transmitiu** ao usuário não some: portão que quer o modelo continuando mantém o texto e só acrescenta a nota para o modelo (nenhum `assistant_discard` num portão). Descarte só para texto vazio ou cortado.
- Nota de parada diz o motivo REAL: só fala em teto (gasto, tempo) se um teto que o dono configurou disparou, com valor e origem (conta, servidor ou bot). Passos de segurança, repetição e falhas dizem o que de fato houve.
- Trava descartável (fase que filtra tools, bloqueio temporário de tool, aborto por estagnação) não entra: nota ao modelo basta. Só ficam as travas que protegem o dono ou impedem laço infinito (ver ADR 0003).

## Configuração agent-first
- O usuário configura conversando: o agente cria rotina, gatilho ou conector via tool, e a UI mostra um resumo em frase ("Uma vez · 03/10 às 10:00", "A cada 50 min"). Formulário só como fallback recolhido. Não exponha modos internos (polling, secrets, cron cru) na UI.
- Perfil do bot só muda no onboarding ou com pedido explícito. Preferência do usuário vai para `memory`.

## Conectores
- Com conector conectado, crie e edite recursos **pelo conector**, nunca pelo navegador do sandbox (conta diferente → 403 depois).
- Conexões são escopadas por dono (`ownerIds`). Nunca liste as de todos.
