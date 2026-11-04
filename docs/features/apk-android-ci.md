# APK Android pelo GitHub Actions

- **Status:** entregue
- **Data:** 2026-11-04
- **Issues/PRs:** -

## O que é
Um workflow (`apk-android.yml`) que gera o APK do app mobile no GitHub e o publica como artifact e, em tag, como Release.

## Problema
O build na nuvem do Expo tem fila e, no perfil `preview`, morreu com "Gradle build daemon disappeared unexpectedly" (falta de memória ao compilar o C++ nativo para 4 ABIs). Cada tentativa também gasta a cota de builds do EAS.

## Por que existe
`eas build --local` roda o mesmo build no runner do GitHub (7 GB de RAM, sem fila), com as credenciais de assinatura ainda remotas no EAS. O perfil `preview` agora compila só `arm64-v8a` (`ORG_GRADLE_PROJECT_reactNativeArchitectures` em `apps/mobile/eas.json`), o que corta a maior parte do C++.

## Alternativas descartadas
- Build na nuvem do Expo: fila e a falha de memória acima.
- Máquina própria: manutenção sem ganho.

## Como disparar
- **Tag:** `git tag apk-0.3.0-beta.1 && git push origin apk-0.3.0-beta.1`. Gera o APK e cria um Release (pré-lançamento) com o arquivo anexado.
- **Manual:** aba Actions > "APK Android" > Run workflow (perfil opcional, padrão `preview`). Gera só o artifact. O botão só aparece depois que o workflow estiver no branch padrão; antes disso, só por tag.

## O que o dono precisa configurar (uma vez)
1. Em expo.dev: Account settings > Access tokens > Create token (nome ex.: `github-actions`). Copie o valor, que só aparece uma vez.
2. No GitHub, repositório `ali-ali18/Atlas`: Settings > Secrets and variables > Actions > New repository secret, nome `EXPO_TOKEN`, valor o token.
3. As credenciais de assinatura Android já devem existir no EAS (o perfil usa as remotas). Se for a primeira vez, rode um `eas credentials` ou um build normal uma vez para criá-las.

Sem o secret, o workflow falha logo no primeiro passo com a mensagem explicando.

## Onde baixar o APK
- Pela tag: página Releases do repositório, arquivo `atlas-preview.apk`.
- Pelo manual (e também pela tag): na página da execução em Actions, seção Artifacts (`atlas-preview-apk`, guardado por 14 dias).

## Custo
Repositório público: minutos grátis. Privado: plano Free tem 2.000 min/mês (runner Linux); um build leva cerca de 20 a 40 min, com timeout de 60. O cache do Gradle reduz as próximas execuções.

## Cuidados
- O APK é só `arm64-v8a`: não roda em emulador x86 nem em aparelho de 32 bits.
- Dependência nativa nova ou alterada (pacote com código Android/iOS, mudança no `app.json`, SDK do Expo) pede APK novo. Mudança só de JavaScript e assets vai pelo ar no canal `preview` (`expo-updates`), sem build.
- `@babel/plugin-transform-react-jsx` é dependência explícita do `apps/mobile` porque o `nativewind/babel` pede o plugin pelo nome e o pnpm limpo (CI) não o expõe.
- A versão do `eas-cli` está fixada no workflow (`27.4.1`); atualize junto com o `package.json` do mobile.

## Riscos
Não altera api, worker nem web. O `env` do perfil `preview` também vale para o build na nuvem do Expo (mesmo ajuste de ABI).

## Disparo por commit `[apk]`
Quem não pode criar tag (ex.: uma sessão de agente que só envia o próprio branch) dispara o build com um commit que tenha `[apk]` na mensagem, em qualquer branch. O workflow cria sozinho a tag `apk-<perfil>-<nº da execução>` naquele commit e publica a Release com o APK. Pushes sem a marca pulam o job.
