# Avisos de terceiros (app mobile)

## noVNC 1.7.0 (core)

- Projeto: https://github.com/novnc/noVNC (tag `v1.7.0`), pacote npm `@novnc/novnc`.
- Licença: **Mozilla Public License 2.0 (MPL-2.0)** para a biblioteca `core/` (texto em `node_modules/@novnc/novnc/docs/LICENSE.MPL-2.0` e em https://www.mozilla.org/MPL/2.0/). Copyright (C) 2022 The noVNC authors (`AUTHORS` do pacote).
- Uso: só o `core/` (RFB), **sem nenhuma modificação** nos arquivos do noVNC. `scripts/build-novnc-bundle.mjs` apenas os empacota (esbuild, minificado) em `lib/novnc-bundle.generated.ts`, que o app embute na página do viewer. Como o código-fonte do noVNC é publicado pelo próprio projeto na tag acima, ele continua disponível nos termos da MPL-2.0 (arquivo por arquivo).
- Não usamos nada de `app/`, das fontes, dos ícones nem do `vnc.html` do noVNC (esses têm outras licenças, BSD/OFL).
- Dependência do core: **pako** (`vendor/pako`, MIT, Copyright (C) 2014-2016 by Vitaly Puzrin), empacotada junto.

## esbuild

- Ferramenta de build (devDependency), MIT. Não vai para o app.
