# Internacionalização da interface (i18n)

Dicionário próprio, tipado e sem dependência. Idiomas: `pt-BR` (fonte da verdade), `en-US`, `es-ES`.
Não confundir com o idioma do **bot** (`lib/bot-language.ts`).

## Por que não `next-intl`
O app inteiro é uma SPA atrás de login (um `Template4Client` gigante), sem URLs por idioma e sem SEO por
idioma. Não precisamos de roteamento `/[lang]`, só de: idioma por requisição, texto tipado e datas/números
no idioma. Isso cabe em ~150 linhas, com chave inexistente falhando no typecheck e sem dependência nova
(licença, manutenção, tamanho de bundle). Se um dia precisarmos de ICU completo (gênero, select aninhado),
a troca é local: só `translator.ts` e `provider.tsx` conhecem o formato.

## Como funciona
1. O idioma é resolvido a cada requisição, sem cookie do idioma resolvido (o `proxy.ts` não mexe nele; só a escolha explícita é guardada).
2. `app/layout.tsx` resolve o idioma (`lib/i18n/server.ts`): escolha do usuário (`atlas-locale-pref`) → `Accept-Language` → pt-BR,
   põe em `<html lang>` e entrega o dicionário ao `I18nProvider`. Ler cookie/header torna as rotas dinâmicas.
3. Componentes de cliente usam `useT()`/`useTranslations()`; de servidor, `await getTranslations()`.
4. Configurações → Geral → "Idioma da interface" (Automático / Português / English / Español) grava o cookie e **recarrega a página**
   (várias telas guardam texto já montado no estado; recarregar troca tudo de uma vez). Na tela de login há `UiLocaleSwitcher`.
   Ponto de extensão: guardar a escolha na conta (ver `server.ts` e `preference.ts`).
5. `packages/ui` não importa o app: os textos fixos dele (aprovação, plano, copiar código...) vêm de `UiCopy`/`UiCopyProvider`.
   Texto novo ali = campo em `packages/ui/src/components/ui-copy.tsx` + chave `ui.*` nos 3 idiomas + linha em `ui-copy.ts` (um teste garante que
   o pt-BR do app e o padrão do pacote são o mesmo texto).

## Traduzir um componente
1. Escolha (ou crie) o arquivo da área em `messages/pt-BR/<area>.ts`. Chaves `area.assunto`, descritivas, em inglês:
   ```ts
   export const sidebar = {
     "sidebar.newChat": "Nova conversa",
     "sidebar.unread": "{count} não lidas",          // {param} vira argumento tipado
     "sidebar.bots.one": "{count} bot",               // plural: .one / .other (+ .zero/.few/.many se o idioma pedir)
     "sidebar.bots.other": "{count} bots",
   } as const;
   ```
2. Registre `...sidebar` em `messages/pt-BR/index.ts` e crie o mesmo arquivo em `messages/en-US/` e `messages/es-ES/`:
   ```ts
   import type { sidebar as ptBR } from "../pt-BR/sidebar";
   import type { NamespaceMessages } from "../../translator";
   export const sidebar: NamespaceMessages<typeof ptBR> = { ... };
   ```
   Registre também nos `index.ts` dos outros idiomas. Faltou uma chave: não compila.
3. No componente:
   ```tsx
   const { t, tn } = useTranslations();   // ou const t = useT()
   <Button aria-label={t("sidebar.newChat")}>{t("sidebar.newChat")}</Button>
   {tn("sidebar.bots", bots.length)}
   ```
   Atributos (`aria-label`, `title`, `placeholder`, `alt`) e toasts também. Texto vindo do servidor/modelo não se traduz aqui.
4. Função pura que monta texto (ex.: `routine-map.ts`): receba `t` (ou `Translator`) por parâmetro; o componente chama com o `t` do hook. Em teste use `createTranslator("pt-BR")`.
5. Datas e números: nunca `toLocaleString("pt-BR")` nem `Intl` com idioma fixo. Use `lib/format.ts` (`useFormat()` no componente, ou `formatDate(valor, locale)`).
6. Teste: os testes de paridade (`translator.test.ts`) já cobrem chaves e `{parametros}` iguais entre idiomas. Teste de componente
   sem provider renderiza em pt-BR (o contexto padrão); para outro idioma, envolva em `<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>`.

## Onde achar o que falta
`rg -n "[áàâãéêíóôõúç]" apps/web --glob "!*.test.*"` lista texto em pt-BR escrito direto. Textos em `packages/shared` (rótulos como
`AUTONOMY_LEVEL_LABELS`, `DEV_APPROVAL_*`, `formatCompactionLine`) também são pt-BR: traduza no app com chaves próprias (como em
`chat-thread/permission-copy.ts`) em vez de mexer em `shared`, que também serve prompts.

## Funções puras com texto
Receba `translator: Translator = defaultTranslator` (ou `t`) como último parâmetro: o padrão pt-BR mantém chamadas e testes antigos iguais, e o
componente passa o do `useTranslations()`. Exemplos: `workingStatusLabel`, `mobileSettingsGroups`, `botActionItems`, `updatedAgo`.

## Testar
- Chaves/parâmetros iguais entre idiomas: `translator.test.ts` (automático).
- Componente em outro idioma: `renderToStaticMarkup(<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>…</I18nProvider>)`;
  veja `chat-thread/composer-i18n.test.tsx`.
- Plural: chaves `.one`/`.other`; no pt-BR o 0 cai em `.one`, então trate "nenhum" com chave própria antes de chamar `tn`.
- Nome de chave: não termine uma chave normal em `.one`/`.few`/`.many`/`.zero` (o teste de paridade trata como plural).

## Convenções
- pt-BR é a fonte: escreva ali primeiro. Texto que o usuário vê, nunca internals (ver `70-padroes-produto.md`).
- Nomes de produto: pt Painéis · Rotina · Alerta · Biblioteca · Habilidades / en Panels · Routines · Alerts · Library · Skills / es Paneles · Rutinas · Alertas · Biblioteca · Habilidades.
- Sem concatenar frases ("Você tem " + n + " itens"): uma chave com `{n}`, porque a ordem das palavras muda por idioma.
- Plural sempre por `tn`, nunca `n === 1 ? "item" : "itens"`.
- Idioma novo: acrescente em `UI_LOCALES`/`UI_LOCALE_LABELS` (`locales.ts`), crie `messages/<id>/` (uma cópia de `en-US/`), a linha em `messages/index.ts`. O seletor já o reconhece.
- Idioma da fala (ditado) e do bot ficam em `lib/dictation.ts` e `lib/bot-language.ts`.
