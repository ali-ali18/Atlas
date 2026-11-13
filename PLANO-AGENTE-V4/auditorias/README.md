# Auditoria de fase do Motor v4

Toda fase termina com uma auditoria independente **antes** do PR ir para `harness/v4`. O processo é o mesmo que o repositório já usa: feature, auditoria, correções confirmadas. Aqui ele fica formalizado para qualquer conta do Claude rodar igual. A conta principal (plano maior) é a preferida, porque roda mais auditores e modelos mais fortes.

## Sequência de commits de uma fase
```
feat/refactor/test(...)  ...                         ← itens da fase (PROGRESSO.md)
docs(plano): auditoria da F<n> (<k> achados)          ← relatório em auditorias/F<n>.md
fix(<escopo>): <o que muda> (auditoria F<n>, A<id>)   ← um commit por achado confirmado, com teste de regressão
docs(plano): auditoria da F<n> fechada                ← status final e reauditoria
```

## Passo 1: auditores em paralelo (somente leitura, sem viés)
- Cada auditor é um agente **novo**. Ele recebe **só**:
  - o arquivo da fase (`05-fases.md`, trecho);
  - o contrato (`06-contrato-de-comportamento.md`);
  - as regras de `.agents/rules/`;
  - o diff (`git diff harness/v4...<branch da fase>`).
- Ele **nunca** recebe o raciocínio nem a conclusão de quem implementou.
- Até 3 em paralelo, conforme `80-fluxo-de-trabalho.md`. Na conta principal, rodar as 5 lentes em duas levas.

| Lente | O que procura | Modelo |
|---|---|---|
| **Segurança** | IDOR e escopo por dono; segredo, cartão ou CVV em log, SSE, journal ou `tool_result`; injeção de prompt (canais, taint, trifeta); portão de aprovação contornável; SSRF; caminho de arquivo; webhook sem assinatura | Opus na conta principal, senão Sonnet. Segunda opinião de outro provedor quando houver cota. |
| **Bugs e correção** | casos de borda, concorrência e lease, retomada de checkpoint, migration com api e worker em versões diferentes, dado antigo no banco, fuso e datas, erros engolidos | Sonnet |
| **Testes** | item sem teste; teste que não testa nada (mock demais, `assert` fraco); invariante do contrato sem teste; replay faltando; teste que depende de rede ou de relógio real | Sonnet |
| **Contrato e regras** | regex de comportamento, resposta reescrita, import do legado, herança de tarefa entre runs (cláusula 17), linguagem interna para o usuário, `any` ou `as unknown as`, arquivo gigante | Sonnet |
| **Custo e desempenho** | tokens do "Bom dia", prefixo de cache instável, tool ou schema que entrou no núcleo sem precisar, consulta N+1, polling | Haiku ou Sonnet |

Além das lentes, quando o Claude Code estiver disponível, rodar também `/security-review` e `/code-review high` sobre o diff da fase e juntar os achados no mesmo relatório.

## Passo 2: verificação (nenhum achado é corrigido sem confirmar)
- Um verificador novo recebe cada achado e tenta reproduzir com um teste que falha, um comando ou a leitura do caminho exato.
- Veredito por achado:
  - `confirmado`: tem teste ou passo que reproduz;
  - `plausível`: o cenário é real, mas não deu para reproduzir;
  - `falso positivo`: com o motivo.
- Achado de **segurança** `plausível` é tratado como confirmado.

## Passo 3: correção
- Um commit por achado confirmado: `fix(<escopo>): <o que muda> (auditoria F<n>, A<id>)`.
- O commit traz o **teste de regressão** que falhava antes.
- O que não for corrigido precisa de justificativa escrita no relatório (`aceito`) ou vira issue no GitHub (`fora do escopo`).

## Passo 4: reauditoria do delta
- Um auditor novo olha **só os commits de correção**: a correção fecha o achado sem abrir outro?

## Portão da fase
A fase só vai para PR quando:
- não sobra nenhum achado `crítico` ou `alto` aberto;
- todo `médio` está corrigido, aceito com motivo ou virou issue;
- `typecheck`, as suítes e a matriz de eval da fase estão verdes;
- o relatório `auditorias/F<n>.md` está fechado.

## Formato do relatório (`auditorias/F<n>.md`)
```
# Auditoria da F<n>: <nome>
Data · branch · commits auditados (de..até) · auditores (lente → modelo)

| ID | Lente | Severidade | Arquivo:linha | Cenário de falha | Veredito | Status | Commit |
|----|-------|------------|---------------|------------------|----------|--------|--------|
| A1 | Segurança | alto | packages/agent/src/contract/approve.ts:42 | ... | confirmado | corrigido | abc1234 |

Reauditoria: <ok | novos achados>
Resumo para o dono (pt-BR simples, sem jargão)
```
Severidades:
- `crítico`: vaza segredo ou dado de outro usuário, ou executa efeito sem aprovação;
- `alto`: perde dado, burla contrato ou quebra o run;
- `médio`: comportamento errado com contorno;
- `baixo`: qualidade.

## Prompt base do auditor (copiar e preencher a lente)
```
Você é auditor independente, somente leitura, lente: <LENTE>.
Leia: PLANO-AGENTE-V4/05-fases.md (seção F<n>), PLANO-AGENTE-V4/06-contrato-de-comportamento.md,
.agents/rules/*.md e o diff `git diff origin/harness/v4...origin/<branch>`.
Procure só problemas da sua lente. Para cada achado devolva: arquivo:linha, cenário concreto de falha
(entrada → resultado errado), severidade (crítico/alto/médio/baixo) e como reproduzir.
Não proponha refatorações fora da lente. Não edite nada. Se não achar nada, diga "sem achados" e o que conferiu.
```
