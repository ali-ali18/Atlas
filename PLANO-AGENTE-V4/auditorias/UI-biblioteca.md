# Auditoria das telas da Biblioteca: Agenda e Caderno

07/11/2026. Branch `feat/harness-v4-ui-biblioteca`, diff `276b77f1..HEAD` (a base é o commit `276b77f1`).

**Auditores:** auditoria independente das telas, só leitura, com as lentes de produto e componentes (A), backend e contrato (B) e testes e prévias (T).

**Resultado:** um alto (A1+T1): a regra do Caderno mostrava o nome interno da ferramenta ("Só em: drive list files"), e os testes consagravam isso.

**Grupo de correção:** um só, no worktree `/home/user/atlas-ui`.

| ID | Lente | Sev. | Onde | Cenário | Status |
|---|---|---|---|---|---|
| A1+T1 | produto/testes | alto | `notebook/notebook-model.ts` (`ruleMatchLabel`) | A linha da regra mostra o nome da ferramenta ("Só em: drive list files"); os testes exigiam o vazamento. | corrigido (9dec7f60): o alvo vira frase de produto ("Só para: listar arquivos do Drive") quando está num mapa conhecido (Gmail, Drive, Agenda do Google, GitHub); fora dele é omitido e a linha fica só com a classe. Testes novos falham com `_` ou com o nome em espaços, nos 3 idiomas |
| A2 | produto | médio | `confirm-alert.tsx` × apagar nota | Apagar nota mostra o selo "Precisa de você" e o ícone de alerta, mas foi o próprio usuário que clicou. | corrigido (2c297249): `ConfirmAlert` ganhou `selfConfirm` (sem selo nem ícone enquanto pendente; decidido, o selo volta) |
| A3 | componentes | médio | `agenda-section.tsx` × `notebook/deletable-row.tsx` | O padrão "lixeira no hover/pressão longa + confirmar" existia duas vezes (AlertDialog na Agenda, linha no Caderno). | corrigido (2c5809a7): `DeletableRow` sobe para `chat-context-panel/` com `canDelete`, `trailing` e `rowData`; cancelar combinado confirma na própria linha, como apagar nota ou regra |
| A4+B3 | produto/contrato | médio/baixo | `agenda-section.tsx`, `notebook-section.tsx`, `use-engine-v4.ts` | Dois sinais de "v4 ligado" (`enabled` da lista e `capabilities.engineV4`), comentário desatualizado e cache do sinal sem validade. | corrigido (a78f9d71, 96f8bfa5): as duas seções usam `useEngineV4` (e resposta da Agenda sem listas vira "não consegui carregar", não derruba a tela); a Agenda nem busca com o v4 desligado; o cache vale 60 s e é esquecido ao sair da conta; sem chamada extra por bot |
| A5 | produto | baixo | `notes-view.tsx` | Título de nota com `truncate` e sem forma de ver inteiro. | corrigido (067d44a6): `line-clamp-2` (o limite do título é 120 caracteres) |
| A6 | custo | baixo | `notebook-section.tsx` | O Caderno carregava mesmo com a Biblioteca fechada. | corrigido (a78f9d71): recebe `active` como a Agenda e só monta o conteúdo quando visível (depois de aberto, fica montado para não perder edição) |
| A7 | regras | baixo | `agenda-section.tsx` | Arquivo acima de ~250 linhas. | corrigido (36cbf8d4): `agenda-card.tsx`, `agenda-list.tsx` e `agenda-section.tsx` (74 linhas) |
| A8 | produto | baixo | `i18n/messages/pt-BR/agenda.ts` | "Agenda do Bot" no pt-BR contra "Bot agenda" e "Agenda del bot". | corrigido (b5700904): "Agenda do bot" |
| B1 | bugs | médio-baixo | `routes/agenda.ts`, `db/agenda.ts` | Com mais de 100 encerrados a lista pegava os 100 de `dueAt` mais antigo e os mais novos sumiam. | corrigido (5850c90c): `listEndedAgendaItems` (consulta própria, escopada por dono e bot, `doneAt` decrescente, limite 10). Teste de db com Postgres real (105 encerrados; o caminho antigo perdia o mais novo) e teste de rota (dono, ordem, limite) |
| B2 | bugs | baixo | `night-review-block.tsx` | `busyId` único: um segundo "Desfazer" em voo sobrescrevia o estado do primeiro. | corrigido (aef99cc9, 807addc0): conjunto de ids (`withBusy`); cada pedido trava só o próprio botão e clique repetido no mesmo item é ignorado |
| T2 | testes | baixo | `e2e/__previews__/agenda`, `caderno` | Faltavam as prévias da Agenda vazia no desktop e da confirmação de cancelar no celular. | corrigido (commit de prévias abaixo): as duas foram geradas (a de celular exigiu soltar o dedo no roteiro da prévia, porque a pressão longa engole o primeiro clique de propósito) e todas as afetadas foram regeradas (regras sem nome de ferramenta, apagar nota sem selo, Agenda na linha unificada). O roteiro da Agenda passou a ligar o v4 por `/v1/settings` |

## Reauditoria
Pendente.

## Resumo para o dono
Pendente.
