// Fixtures dos testes do motor v2 (não é um teste). Duas páginas parecidas com
// o que quebra o leitor do DOM: iframe de OUTRO site (OOPIF, de um segundo
// servidor), shadow DOM, aria-hidden, recorte por overflow/left:-9999px,
// painel lateral (aside) com resposta e milhares de nós de comentário.
import http from "node:http";

/** Servidor extra (outro "site": porta e host diferentes) para o OOPIF. */
export async function startSecondServer(pages) {
	const server = http.createServer((req, res) => {
		const path = String(req.url).split("?")[0];
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(pages[path] ?? "<body>ok</body>");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		// `localhost` x `127.0.0.1` são sites diferentes: o iframe vira processo separado.
		base: `http://localhost:${server.address().port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

export const OOPIF_PAGE = `<body style="margin:4px"><p>Pagamento seguro</p>
<button onclick="document.title='pago';document.body.insertAdjacentHTML('beforeend','<p>pagamento concluído</p>')">Pagar no iframe</button></body>`;

const comment = (i) =>
	`<article class="c"><div><div><span>Autor ${i}</span><div><p>comentário número ${i} do vídeo</p></div></div><div><button>Responder</button><button aria-label="Curtir ${i}">curtir</button></div></div></article>`;

const COMMON_STYLE = `body{margin:0;font:14px sans-serif} main{width:560px} .side{position:absolute;left:600px;top:10px;width:280px}
.panel{height:0;overflow:hidden} .off{position:absolute;left:-9999px}`;

/** Fixture A: tudo que quebra o leitor + `comments` artigos abaixo da dobra. */
export function fixtureA({ oopifBase, comments = 1250 }) {
	return `<!doctype html><html><head><title>Fixture A</title><style>${COMMON_STYLE}</style></head><body>
<nav><a href="/home">Início</a> <a href="/ajuda">Ajuda</a></nav>
<main>
  <h1>Painel do pedido</h1>
  <form onsubmit="return false">
    <input type="text" aria-label="Nome" value="ana">
    <input type="password" aria-label="Senha" value="s3gredo-zzz">
  </form>
  <button id="acc" aria-expanded="false" onclick="document.getElementById('p').style.height='auto'">Abrir seção</button>
  <div class="panel" id="p"><button>Interno do acordeão</button><p>texto escondido do acordeão</p></div>
  <div class="off"><a href="/x">link fora da tela</a></div>
  <div aria-hidden="true"><button>Decorativo</button></div>
  <div id="host"></div>
  <iframe title="Pagamento" src="${oopifBase}/pay" width="400" height="90"></iframe>
</main>
<aside aria-label="Chat" class="side">
  <p>Resposta do assistente: olá, posso ajudar?</p>
  <button id="send" onclick="document.getElementById('log').insertAdjacentHTML('beforeend','<p>mensagem enviada</p>')">Enviar</button>
  <div id="log"></div>
</aside>
<section style="margin-top:600px">${Array.from({ length: comments }, (_, i) => comment(i)).join("")}</section>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button>Dentro do shadow</button>'</script>
</body></html>`;
}

/** Fixture estilo YouTube: painel lateral com a resposta e uma lista enorme de comentários. */
export function fixtureYoutube({ comments = 3750 } = {}) {
	return `<!doctype html><html><head><title>Vídeo</title><style>${COMMON_STYLE}</style></head><body>
<main><h1>Como funciona um motor v2</h1><p>Descrição do vídeo com algumas linhas de texto para ocupar espaço.</p>
<section id="comments"><h2>${comments} comentários</h2>${Array.from({ length: comments }, (_, i) => comment(i)).join("")}</section></main>
<aside aria-label="Resposta" class="side">
  <article><h3>Assistente</h3><p>Resposta pronta: a árvore de acessibilidade resolve isso.</p>
  <button id="copy" onclick="document.title='copiado';document.getElementById('st').textContent='copiado para a área de transferência'">Copiar resposta</button><p id="st"></p></article>
</aside>
</body></html>`;
}
