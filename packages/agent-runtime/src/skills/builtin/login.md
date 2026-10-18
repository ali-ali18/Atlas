---
name: Login em sites
description: How to sign in to a website in the VM browser — saved vault logins, 2FA (TOTP, e-mail code, SMS), SSO, captcha/passkey, verifying the result and when to stop.
when: Read when the user asks to log in, sign in, "entrar", "logar", "autenticar", or a page asks for a password, 2FA or verification code ("código de verificação") in the VM browser.
groups: [browser, vault]
version: 1
---

# Signing in to a site (VM browser)

## 1. Check before you ask
- The session may already be saved in the VM browser: open the site and look (avatar, user name, URL outside `/login`). If you are already signed in, do not log in again.
- Look for a saved login before bothering the user: the prompt lists the vault domains; `secret_list` shows names, site and username (never values). Open the site with the exact host from `secret_list`/the login card (e.g. pucprdigital.grupoa.education), never a shortened or guessed one; once the first navigation works, save the logged-in start URL in `memory`. If one matches the site, use `login_fill` (the page domain must match the saved login; the user approves the first use per conversation).
- On a login wall the runtime already shows the vault card ("Entrar com o login do Cofre"); you do not need to build it. Just wait for the user's click and continue after the run resumes.

## 2. Second step (2FA)
- TOTP (authenticator app): if the vault login has a 2FA secret, call `login_fill` with `fields: ["totp"]` on the code screen (or `{{login:<name>.totp}}` in the allowed tools). You never see the code.
- Code sent by e-mail: the runtime looks it up in the user's connected e-mail and types it; without a connector it shows a card with a code field. Do not read the e-mail yourself to fish for it and never ask for the code in the chat.
- Code by SMS or from a phone app you cannot reach: the card asks the user for the code; wait for it.

## 3. SSO ("Continue with Google/Apple/Microsoft")
- If the vault has a login for the identity provider (for example google.com), prefer it: start the SSO flow, then `login_fill` on the provider page.
- Otherwise let the user do it through the card (open the VM, finish, "Terminei").

## 4. Always human
- Captcha, "I am not a robot", passkeys/security keys, device approval prompts: stop and let the user do it in the VM viewer. Never try to solve or bypass them.

## 5. After signing in
- Your view is stale after a login: when the user says they signed in ("acessei", "pronto", "já entrei") or the run resumes after a login card, `navigate` again to the exact URL and `browser_read` before claiming anything. If it is still a login page, say what you see; do not claim success.
- Confirm it worked (take a `browser_snapshot`): avatar or name visible, URL no longer a login page. Then continue the original task without asking again.
- Cards are limited to one per page per run; if the page still asks for login after the user said they finished, say what you see instead of asking again.

## 6. Never
- Never ask for a password or code in the chat; never type a password yourself with `browser_type`/`type`; never use a login on a different domain from the one saved (`login_fill` refuses it; do not look for a way around it).
- Never put credentials in a URL, a file or a message.

## 7. If it fails twice
Stop. Tell the user plainly what you saw (page, error message, which step) and what they can do (open the VM and finish, fix the saved login in Settings → Cofre). Do not retry in a loop.
