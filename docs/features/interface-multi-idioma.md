# Interface em 3 idiomas

- **Status:** entregue (aguardando merge)
- **Data:** 2026-10-29
- **Issues/PRs:** branch `feat/i18n-all`

## O que é
A interface do Atlas aparece em português do Brasil, English (US) ou Español (España). Em Configurações → Geral → "Idioma da interface" a pessoa escolhe Automático (idioma do navegador), Português, English ou Español.

## Problema
Toda a interface estava escrita em pt-BR. O projeto vai ser aberto (open source) e não é só para o Brasil: quem não lê português não consegue usar nem configurar o produto, mesmo com o bot respondendo no idioma dela (ver `docs/features/idioma-automatico.md`, que trata do idioma do bot, outra coisa).

## Por que existe
Abrir o projeto para quem não é brasileiro sem fork de textos e sem quebrar a experiência atual: em pt-BR a interface fica idêntica.

## Alternativas descartadas
- **`next-intl` (ou similar):** o app é uma SPA atrás de login, sem URL nem SEO por idioma. Não precisamos de rota `/[lang]`, só de idioma por requisição, texto tipado e datas/números no idioma. Cabe em poucas linhas, com chave inexistente falhando no typecheck e sem dependência nova (licença, manutenção, bundle). Se um dia faltar ICU completo, a troca fica em `translator.ts` e `provider.tsx`.
- **Cookie do idioma resolvido no `proxy.ts`:** só a escolha explícita é guardada; o resto é resolvido a cada requisição.
- **Traduzir dentro de `packages/shared`:** ele também serve prompts; os rótulos são traduzidos no app, com chaves próprias.

## Como funciona
- **Idioma:** cookie `atlas-locale-pref` (escolha explícita) → `Accept-Language` → pt-BR (`apps/web/lib/i18n/server.ts`, `locales.ts`).
- **`<html lang>` dinâmico:** `app/layout.tsx` resolve o idioma, preenche `<html lang>` e entrega o dicionário ao `I18nProvider`. Ler cookie e header torna as rotas dinâmicas (antes eram estáticas).
- **Dicionários:** `apps/web/lib/i18n/messages/{pt-BR,en-US,es-ES}/<área>.ts`; pt-BR é a fonte da verdade e os outros idiomas são tipados contra ele (`NamespaceMessages`), com plural (`.one/.other`) e parâmetros `{x}` conferidos por teste de paridade.
- **`packages/ui`:** não importa o app; os textos fixos dele vêm de `UiCopy`/`UiCopyProvider`, e o contexto de idioma dos gráficos cuida de números e datas.
- **Formatação:** `apps/web/lib/format.ts` (`useFormat()`, `formatDate`), nunca `toLocaleString("pt-BR")` fixo.
- **Trocar o idioma** grava o cookie e recarrega a página (várias telas guardam texto já montado no estado). A tela de login tem um seletor próprio.
- **Idioma do bot** continua separado (`lib/bot-language.ts`); seus rótulos "Automático" e "Herdar (Automático)" passam pelo dicionário, e os nomes dos idiomas seguem como autônimos ("Português (Brasil)", "English (US)", "Español (España)").
- **Adicionar um idioma:** incluir em `UI_LOCALES`/`UI_LOCALE_LABELS` (`locales.ts`), criar `messages/<locale>/` com os mesmos arquivos do pt-BR e registrar em `loadMessages`; o typecheck lista o que falta. Conferir também as regras de plural do idioma.
- **Traduzir um componente:** passo a passo em `apps/web/lib/i18n/README.md`.

## Riscos
- **pt-BR idêntico:** o contexto padrão sem provider é pt-BR, então testes e chamadas antigas não mudam; os testes de componente existentes continuam valendo.
- **Mensagens em português vindas do servidor** (ex.: estado de skills e de ambientes de desenvolvimento) são mapeadas por expressão regular em `skills-state` e `dev-environments-state`; se o servidor mudar a frase, o texto cai no original em português (degrada, não quebra). Dívida: o servidor devolver código + parâmetros.
- **Textos já gravados em português** (ex.: "Alerta · …", "Seu dia · …" no histórico) continuam em pt-BR.
- **Rotas dinâmicas:** perde-se o prerender estático das rotas que leem o idioma; o app já é autenticado, então o impacto é pequeno.
- **Deploy com versões mistas:** sem migration nem contrato novo de API; só o web muda.
- **Tradução:** en-US e es-ES são revisáveis; textos novos exigem as três chaves (não compila sem).

## Custo
Sem dependência nova e sem tokens de LLM. O dicionário do idioma ativo é carregado por requisição no servidor e enviado ao cliente (só um idioma por vez).

## Como testar
- `pnpm --filter @workspace/web test` (paridade de chaves, aria-labels, ui-copy, preferência, formatação), `pnpm --filter @workspace/ui test`, `pnpm --filter @workspace/shared test` (`formatCompactionLine`) e `pnpm exec turbo typecheck`.
- Prévia manual: trocar o idioma em Configurações → Geral e conferir desktop e celular, tema escuro.
