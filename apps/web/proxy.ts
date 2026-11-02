import { getSessionCookie } from "better-auth/cookies"
import { NextResponse, type NextRequest } from "next/server"

import { isPublicWebPath } from "@/lib/public-paths"

export function proxy(request: NextRequest) {
  // /login e /p/:token (painel compartilhado por link público; a API autoriza pelo token): casamento exato.
  if (isPublicWebPath(request.nextUrl.pathname)) return NextResponse.next()

  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!api/auth|api/mobile|v1|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
