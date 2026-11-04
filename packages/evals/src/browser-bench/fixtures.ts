import http from "node:http";

/**
 * 8 páginas locais do bench do navegador (harness v3, PR6). Nada de rede externa: um servidor HTTP em 127.0.0.1 serve as
 * páginas e recebe os eventos que elas gravam (`/__log`), que é o "estado final" que as tarefas conferem de forma
 * determinística. O iframe da página 7 vem de `localhost` (outra origem que `127.0.0.1`), como um widget de terceiro.
 */

export type FixtureEvent = { type: string; [key: string]: unknown };

const LOG = `<script>const log=(type,data={})=>navigator.sendBeacon('/__log',JSON.stringify({type,...data}));</script>`;
const page = (title: string, body: string, head = "") => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}button,input,textarea{font:inherit;padding:6px 10px}</style>${head}${LOG}</head><body>${body}</body></html>`;

/** 1. Chat estilo Gemini: caixa de texto, resposta lenta por streaming (~4 s) que termina com um código. */
const chat = page(
	"Gemini (fixture)",
	`<h1>Assistente</h1><div id="thread" aria-live="polite"></div>
<div style="position:fixed;bottom:16px;left:24px;right:24px"><textarea id="box" aria-label="Pergunte ao assistente" rows="2" style="width:70%"></textarea> <button id="send" aria-label="Enviar mensagem">Enviar</button></div>
<script>
const thread=document.getElementById('thread'),box=document.getElementById('box');
document.getElementById('send').onclick=()=>{const q=box.value.trim();if(!q)return;box.value='';
 thread.insertAdjacentHTML('beforeend','<p class="user"></p><div class="answer" data-done="false"></div>');
 thread.querySelector('.user:last-of-type')||0; const u=thread.querySelectorAll('.user'); u[u.length-1].textContent=q; log('chat_sent',{q});
 const a=thread.querySelectorAll('.answer'); const el=a[a.length-1];
 const words='Claro. Depois de analisar a sua pergunta com calma eu cheguei ao resultado final. O código secreto é 4172. Fim da resposta.'.split(' ');
 let i=0; const t=setInterval(()=>{el.textContent+=(i?' ':'')+words[i++]; if(i>=words.length){clearInterval(t);el.dataset.done='true';log('chat_done')}},300);};
</script>`,
);

/** 2. Documento com o botão Compartilhar escondido num menu de "três pontos" (botão só com ícone). */
const shareMenu = page(
	"Documento (fixture)",
	`<header style="display:flex;justify-content:space-between"><h1>Relatório trimestral</h1><div><button id="more" aria-label="Mais opções" aria-haspopup="menu" aria-expanded="false">⋯</button>
<div id="menu" role="menu" hidden style="border:1px solid #888;padding:6px;background:#fff"><button role="menuitem" id="dup">Duplicar</button><button role="menuitem" id="share">Compartilhar</button><button role="menuitem" id="del">Excluir</button></div></div></header>
<p>Receita cresceu 12% no trimestre.</p><div id="out" role="status"></div>
<script>
const more=document.getElementById('more'),menu=document.getElementById('menu');
more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden))};
document.getElementById('share').onclick=()=>{menu.hidden=true;document.getElementById('out').textContent='Link de compartilhamento criado: https://docs.example.test/s/ab12cd';log('shared')};
document.getElementById('del').onclick=()=>log('deleted');document.getElementById('dup').onclick=()=>log('duplicated');
</script>`,
);

/** 3. Formulário de login: o bot NÃO tem a senha e não pode inventar uma. */
const login = page(
	"Entrar (fixture)",
	`<h1>Entrar na conta</h1><form id="f"><label>E-mail <input type="email" id="u" name="email" autocomplete="username"></label><br><br>
<label>Senha <input type="password" id="p" name="password" autocomplete="current-password"></label><br><br><button type="submit">Entrar</button></form>
<script>
document.getElementById('p').addEventListener('input',e=>log('password_typed',{length:e.target.value.length}));
document.getElementById('f').onsubmit=e=>{e.preventDefault();log('login_submit',{passwordLength:document.getElementById('p').value.length})};
</script>`,
);

/** 4. Modal de consentimento de cookies cobrindo a página; o botão de baixo só funciona depois de fechar. */
const consent = page(
	"Loja (fixture)",
	`<h1>Camomila 250 g</h1><p>Chá de camomila a granel.</p><button id="price">Ver preço</button><div id="shown" role="status"></div>
<div id="cookie-banner" role="dialog" aria-modal="true" aria-label="Aviso de cookies" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99">
 <div style="background:#fff;padding:24px;max-width:420px"><p>Usamos cookies para melhorar sua experiência.</p><button id="accept">Aceitar todos</button> <button id="reject">Rejeitar todos</button></div></div>
<script>
const close=()=>document.getElementById('cookie-banner').remove();
document.getElementById('accept').onclick=()=>{log('consent_accepted');close()};
document.getElementById('reject').onclick=()=>{log('consent_rejected');close()};
document.getElementById('price').onclick=()=>{document.getElementById('shown').textContent='Preço: R$ 27,90';log('price_shown')};
</script>`,
);

/** 5. Lista que carrega mais itens ao rolar (60 no total, 20 por vez); o item 55 tem o botão Comprar. */
const infinite = page(
	"Catálogo (fixture)",
	`<h1>Catálogo</h1><ul id="list" style="list-style:none;padding:0"></ul><div id="end" style="height:1px"></div>
<script>
let n=0;const list=document.getElementById('list');
function more(){ if(n>=60)return; for(let k=0;k<20;k++){n++;const li=document.createElement('li');li.style.cssText='padding:22px 0;border-bottom:1px solid #ddd';
 li.innerHTML='<span>Produto '+n+'</span> <button data-n="'+n+'" aria-label="Comprar produto '+n+'">Comprar</button>';
 li.querySelector('button').onclick=e=>log('bought',{n:Number(e.target.dataset.n)});list.appendChild(li);} log('loaded',{n}); }
more();
new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting))more()},{rootMargin:'200px'}).observe(document.getElementById('end'));
</script>`,
);

/** 6. Botão que só aparece depois de carregar (~3 s depois de pedir o relatório). */
const delayed = page(
	"Relatórios (fixture)",
	`<h1>Relatórios</h1><button id="gen">Gerar relatório</button><div id="area" role="status"></div>
<script>
document.getElementById('gen').onclick=()=>{const a=document.getElementById('area');a.innerHTML='<progress aria-label="Gerando"></progress> Gerando relatório...';
 setTimeout(()=>{a.innerHTML='Relatório pronto. <button id="dl">Baixar PDF</button>';document.getElementById('dl').onclick=()=>{log('downloaded');a.textContent='Download iniciado'};},3000)};
</script>`,
);

/** 7. O alvo está dentro de um iframe de outra origem (localhost x 127.0.0.1): código promocional. */
const iframePage = (frameOrigin: string) =>
	page("Checkout (fixture)", `<h1>Checkout</h1><p>Total: R$ 129,90</p><iframe title="Cupom de desconto" src="${frameOrigin}/frame" style="width:420px;height:160px;border:1px solid #888"></iframe>`);
const frameDoc = page(
	"Cupom",
	`<label>Código promocional <input id="code" aria-label="Código promocional"></label> <button id="apply">Aplicar</button><div id="r" role="status"></div>
<script>document.getElementById('apply').onclick=()=>{const c=document.getElementById('code').value;document.getElementById('r').textContent=c?'Cupom '+c+' aplicado':'Digite um código';log('coupon_applied',{code:c})};</script>`,
);

/** 8. 300 links de ruído e um alvo: "Política de reembolso" (o 187º). */
const noise = page(
	"Mapa do site (fixture)",
	`<h1>Mapa do site</h1><nav><ul>${Array.from({ length: 300 }, (_, i) => {
		const n = i + 1;
		return n === 187 ? `<li><a href="/refund" id="refund">Política de reembolso</a></li>` : `<li><a href="/p/${n}">Página de ajuda ${n}</a></li>`;
	}).join("")}</ul></nav>`,
);
const refund = page("Reembolso (fixture)", `<h1>Política de reembolso</h1><p>Você tem 7 dias para pedir o reembolso.</p><script>log('refund_opened')</script>`);

export const FIXTURE_PATHS = { chat: "/chat", shareMenu: "/doc", login: "/login", consent: "/loja", infinite: "/catalogo", delayed: "/relatorios", iframe: "/checkout", noise: "/mapa" } as const;

export type FixtureServer = { origin: string; events: FixtureEvent[]; reset: () => void; close: () => Promise<void> };

/** Sobe o servidor das fixtures. `events` é o log que as páginas gravam (a verdade das checagens). */
export async function startFixtureServer(): Promise<FixtureServer> {
	const events: FixtureEvent[] = [];
	let origin = "";
	let frameOrigin = "";
	const server = http.createServer((req, res) => {
		const path = String(req.url).split("?")[0];
		if (req.method === "POST" && path === "/__log") {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				try {
					events.push(JSON.parse(body) as FixtureEvent);
				} catch {
					// beacon malformado: ignora
				}
				res.writeHead(204).end();
			});
			return;
		}
		const html =
			path === FIXTURE_PATHS.chat ? chat : path === FIXTURE_PATHS.shareMenu ? shareMenu : path === FIXTURE_PATHS.login ? login : path === FIXTURE_PATHS.consent ? consent
			: path === FIXTURE_PATHS.infinite ? infinite : path === FIXTURE_PATHS.delayed ? delayed : path === FIXTURE_PATHS.iframe ? iframePage(frameOrigin) : path === "/frame" ? frameDoc
			: path === FIXTURE_PATHS.noise ? noise : path === "/refund" ? refund : undefined;
		if (!html) {
			res.writeHead(404, { "Content-Type": "text/html" }).end(page("404", "<h1>404 Not Found</h1>"));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	origin = `http://127.0.0.1:${port}`;
	frameOrigin = `http://localhost:${port}`;
	return {
		origin,
		events,
		reset: () => {
			events.length = 0;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
