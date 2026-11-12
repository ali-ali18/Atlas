# Habilidades no motor v4

- **Status:** em andamento
- **Data:** 2026-11-09
- **Issues/PRs:** F9 (frente Habilidades)

## O que é
O bot do motor novo (v4) passa a listar, ler, salvar e apagar as **habilidades** do dono (procedimentos passo a passo em Markdown), como o motor antigo já fazia. O dono vê o mesmo cartão "Aprendi" com "Desfazer".

## Problema
Sem a capacidade, o v4 não "usava" habilidade nenhuma: o índice de habilidades só existia no prompt do motor antigo.

## Por que existe
Paridade com o legado (`packages/agent-runtime/src/tools/skills.ts`) respeitando o contexto lazy: o prompt sempre carregado só ganha uma linha curta; o corpo da habilidade entra só quando a tarefa casa.

## Alternativas descartadas
- Injetar o índice completo (nome + descrição, até 6000 caracteres) no prompt, como no legado: engorda o "Bom dia". Aqui entram só os NOMES, dentro do resumo de 160 caracteres da capacidade (os que não cabem viram `+N`; `skill_list` mostra todos).
- Reimplementar a gravação: o adaptador usa `applySkillProposal` e `deleteSkillDoc` de `@workspace/db` (validação, redação de segredo, limites, revisão e "Desfazer" já estão lá).
- Habilidades de fábrica (`skills/builtin/*.md`): descrevem o fluxo do motor antigo (ferramentas do legado) e moram no `agent-runtime`; ficam de fora desta fase.

## Como funciona
- Capacidade lazy `skills` (`packages/agent/src/capabilities/skills/`), preset `full`, porta `Skills` (`packages/agent/src/ports/skills.ts`), adaptador `apps/worker/src/v4-adapters/skills.ts`.
- **Uso no run:** o resumo da capacidade traz os nomes das habilidades ativas (conta + bot). Quando o pedido casa, o modelo carrega a capacidade e chama `skill_read` (o corpo só entra aqui), depois segue o procedimento com as ferramentas e aprovações normais. A habilidade nunca dispensa aprovação.
- Tools:
  - `skill_list` (leitura): nome, quando usar, situação (rascunho / desligada).
  - `skill_read` (leitura): o corpo de uma habilidade ativa.
  - `skill_save` (`write_internal`, `confirm: when_untrusted`): cria ou edita (corpo inteiro ou `patch` por trechos). Grava na hora e mostra o cartão "Aprendi" com Desfazer. Depois de ler página, e-mail, arquivo ou MCP no run, o dono aprova no cartão ANTES de gravar: conteúdo de fora não vira instrução sem ele ver. Duplicata (mesmo nome ou parecida) é recusada com a dica do que fazer. No máximo uma gravação por habilidade por run.
  - `skill_delete` (`destructive`): o dono sempre confirma, mesmo em autonomia total.
- **Escopo:** o `userId` e o bot vêm do run. O run só enxerga as habilidades da conta e as do seu bot; outro bot, outro dono e recurso inexistente respondem igual ("não existe"). `scope: "bot"` sem bot no run falha com o motivo.
- **Sem dono presente** (rotina, agenda, subagente): só `skill_list` e `skill_read` (ninguém para ver o aviso nem desfazer).
- **Texto para o usuário:** "Habilidade", nunca "skill" (o resumo do cartão e o recibo usam "Habilidade"; as instruções mandam falar assim).
- **Sono (F5.3):** as PROPOSTAS de habilidade do sono ficam no relatório do sono (`sleep-reports`, `kind: "skill"`, aberta ou dispensada), não na tabela de habilidades; a UI do caderno cria a habilidade só quando o dono aceita. Por isso a capacidade NÃO as lista: antes de aceitas não são habilidades. Se o dono aceitar, vira uma habilidade comum e aparece em `skill_list`.
- `findSimilarSkill` (anti-duplicata) subiu para `packages/shared/src/skill-similar.ts`; o motor antigo passa a chamar a versão compartilhada (mesmo comportamento, teste dele intacto).

## Riscos
- Instrução persistente: uma habilidade escrita a partir de dado de fora seria prompt injection durável. Coberto por `confirm: when_untrusted` e pelo texto da tool; teste: depois de uma leitura não confiável o `skill_save` vira `pending_approval` e nada é gravado antes da aprovação.
- O nome da habilidade entra no prompt estável (resumo): é um slug validado (letras, dígitos e hífens), sem texto livre. Mudar o conjunto de nomes invalida o cache do prompt daquele dono (igual ao índice do legado).
- Versões mistas no deploy: sem migration nem contrato novo; só leitura/escrita da tabela existente. O cartão `skill` e o "Desfazer" são os do legado.

## Custo
"Bom dia" ganha uma linha de índice (`< 60` tokens, coberto por `economy.test.ts`); schema das 4 tools e instruções só ao carregar a capacidade.

## Como testar
- `pnpm --filter @workspace/agent test` (capacidade, presets, economia, invariantes do contrato).
- `pnpm --filter @workspace/shared test` (`skill-similar`).
- Worker: `tsx --test src/v4-adapters/skills.test.ts src/v4-adapters/index.test.ts`.
