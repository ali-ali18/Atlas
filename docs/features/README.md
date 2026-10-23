# Documentação de features

Uma feature grande ganha `docs/features/<nome>.md`. Decisão de arquitetura vai em ADR (`docs/adr/`). Regra: `.agents/rules/80-fluxo-de-trabalho.md`.

## Modelo

```markdown
# <Nome da feature>

- **Status:** proposta | em andamento | entregue
- **Data:** AAAA-MM-DD
- **Issues/PRs:** #

## O que é
Uma ou duas frases, na linguagem do usuário.

## Problema
Quem sofre, em que situação, qual o custo de não resolver.

## Por que existe
Justificativa da abordagem escolhida.

## Alternativas descartadas
- <opção>: por que não.

## Como funciona
Fluxo, pacotes e arquivos envolvidos, contratos (eventos, tipos, rotas).

## Riscos
O que pode quebrar (consumidores, dados existentes, deploy com versões mistas, jobs, cache, replays/evals) e como foi coberto.

## Custo
Infra, tokens de LLM, desempenho (números medidos antes e depois).

## Como testar
Testes, replays/evals e prévias.
```
