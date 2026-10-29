import { getSessionCookie } from "better-auth/cookies"
import { NextResponse, type NextRequest } from "next/server"

import { isPublicWebPath } from "@/lib/public-paths"
import {
  isUiLocalePreference,
  resolveUiLocale,
  UI_LOCALE_COOKIE,
  UI_LOCALE_COOKIE_MAX_AGE,
  UI_LOCALE_PREF_COOKIE,
} from "@/lib/i18n/locales"

/**
 * Idioma da interface na primeira visita: sem escolha do usuário (cookie `atlas-locale-pref`), usa o
 * `Accept-Language` e grava `atlas-locale` para o cliente. O layout resolve o mesmo idioma sozinho
 * (não depende deste cookie ter chegado), então a ordem de gravação não afeta a renderização.
 */
function withLocaleCookie(request: NextRequest, response: NextResponse): NextResponse {
  const rawPref = request.cookies.get(UI_LOCALE_PREF_COOKIE)?.value
  const locale = resolveUiLocale({
    preference: isUiLocalePreference(rawPref) ? rawPref : null,
    acceptLanguage: request.headers.get("accept-language"),
  })
  if (request.cookies.get(UI_LOCALE_COOKIE)?.value !== locale) {
    response.cookies.set(UI_LOCALE_COOKIE, locale, { path: "/", sameSite: "lax", maxAge: UI_LOCALE_COOKIE_MAX_AGE })
  }
  return response
}

export function proxy(request: NextRequest) {
  // /login e /p/:token (painel compartilhado por link público; a API autoriza pelo token): casamento exato.
  if (isPublicWebPath(request.nextUrl.pathname)) return withLocaleCookie(request, NextResponse.next())

  if (!getSessionCookie(request)) {
    return withLocaleCookie(request, NextResponse.redirect(new URL("/login", request.url)))
  }

  return withLocaleCookie(request, NextResponse.next())
}

export const config = {
  matcher: ["/((?!api/auth|v1|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
