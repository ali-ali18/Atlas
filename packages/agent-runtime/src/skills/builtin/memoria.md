---
name: Memória
description: How to clean, organize and fix the saved memory — listing entries with refs, grouping duplicates and contradictions, merging instead of deleting, and keeping each layer in its scope.
when: Read when the user asks to organize, clean, review, dedupe, forget or correct the memory ("organizar/limpar/revisar memória", "duplicadas", "esquece isso", "corrige o que você sabe de mim"), or when a memory action fails.
groups: []
version: 1
---

# Memória

Cada entrada da memória tem uma ref `[xxxx]` (4 caracteres). Use sempre a ref, nunca tente reproduzir o texto: trechos curtos (ex.: um nome) batem em várias entradas e falham.

## 1. Procedimento

1. `memory` com `action: "list"` (sem `target` mostra as duas camadas, com uso em caracteres).
2. Agrupe: duplicadas (mesmo fato escrito de formas diferentes), contradições (vale a mais recente ou a que o usuário confirmar) e entradas fora de escopo.
3. Correção única e óbvia (um fato errado, uma duplicata clara): faça direto.
4. Mais de uma remoção ou fusão: mostre um plano curto (o que junta, o que apaga, o que fica) e espere o ok do usuário antes de executar.
5. Execute com refs:
   - `merge` (`refs: [...]`, `content`) junta 2+ entradas da mesma camada numa só, mantendo a versão mais completa. Prefira `merge` a apagar e adicionar de novo.
   - `replace` (`ref`, `content`) corrige uma entrada.
   - `remove` (`ref`) apaga uma entrada que não vale mais.
6. Se a ação falhar, a resposta já traz as candidatas com refs: repita com a ref certa, sem pedir nada ao usuário.
7. Responda em uma ou duas linhas o que mudou e avise que dá para desfazer em Configurações do bot, aba Memória, em "O que mudou".

## 2. Escopo de cada camada

- `user` (Sobre você): só fatos pessoais estáveis do usuário: nome, idioma, fuso, profissão, cidade, estudo, contato, preferências de comunicação. Vale para todos os bots.
- `memory`: tudo que é deste bot: o que o usuário quer dele, projetos, decisões, contexto de trabalho.
- Descrição, tom ou papel do bot nunca é memória: é o perfil do bot. Se achar na memória, proponha apagar.
- Pedido de rotina ou lembrete nunca é memória: vai para Rotinas (`propose_routine`).
- Entrada na camada errada: junte ou mova (adicione na camada certa e remova a antiga) só depois do ok.

## 3. Como escrever

- Entradas curtas e densas, uma ideia por entrada: `Nome: Ana Souza (Ana)`, não frases longas.
- Sem repetir o mesmo fato em duas entradas; ao fundir, mantenha todos os dados distintos e descarte só o que repete.
- O espaço é limitado (veja o uso no `list`): organizar existe para liberar espaço, não para perder informação.
