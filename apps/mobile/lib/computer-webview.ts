// Regras puras da WebView da tela do Computador: que endereços ela pode abrir e o script que arruma o noVNC.

/** Origem (esquema + host + porta) de um endereço http(s), ou null se não for um endereço válido. */
export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
	} catch {
		return null;
	}
}

/** A WebView só navega dentro da origem do servidor salvo: qualquer outra (inclusive `data:`, `blob:`, `file:`) é recusada. */
export function isAllowedNavigation(url: string, serverOrigin: string | null): boolean {
	if (!serverOrigin) return false;
	return originOf(url) === serverOrigin;
}

/** Mensagem que o script injetado manda quando o noVNC mostra erro de conexão. */
export const DROP_MESSAGE = "drop";

/** Fundo preto, sem barra de controle do noVNC nem seleção de texto. Roda antes do conteúdo para não piscar. */
export const HIDE_CHROME_JS = `(function(){try{var s=document.createElement('style');s.textContent='html,body{background:#000!important;margin:0;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#noVNC_control_bar_anchor,#noVNC_control_bar_handle{display:none!important}';(document.head||document.documentElement).appendChild(s)}catch(e){}})();true;`;

/**
 * Depois de carregar: observa a faixa de status do noVNC e avisa o app quando ela vira erro (conexão caída), para
 * renovar o link. Usa a CLASSE `noVNC_status_error` (estável), não o texto (que muda com o idioma).
 */
export const WATCH_DROP_JS = `(function(){try{var last=false;var watch=function(){var el=document.getElementById('noVNC_status');if(!el)return false;new MutationObserver(function(){var bad=(el.className||'').indexOf('noVNC_status_error')>=0;if(bad&&!last){last=true;try{window.ReactNativeWebView.postMessage('${DROP_MESSAGE}')}catch(e){}}else if(!bad){last=false}}).observe(el,{attributes:true,attributeFilter:['class']});return true};if(!watch())document.addEventListener('DOMContentLoaded',watch)}catch(e){}})();true;`;

/**
 * Antes do noVNC rodar: se ler `localStorage` ou `sessionStorage` lança erro, põe no lugar um Storage em memória.
 * A rota `vt` do servidor responde com `Content-Security-Policy: sandbox allow-scripts` (sem `allow-same-origin`), e num
 * documento assim o navegador lança `SecurityError` ao ler `window.localStorage`, o que derruba o `WebUtil.initSetting` do
 * noVNC. A CSP não é afrouxada: o app só dá ao noVNC um armazenamento que não persiste (as preferências valem enquanto a
 * página estiver aberta). Storage que funciona NÃO é trocado. Se o navegador não deixar redefinir a propriedade, o
 * `try` interno engole o erro e tudo fica como estava (plano B: o servidor injetar o shim no `vnc.html`). Não loga nada.
 */
export const STORAGE_SHIM_JS = `(function(){function make(){var m={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null},get length(){return Object.keys(m).length}}}['localStorage','sessionStorage'].forEach(function(n){var broken=false;try{void window[n]}catch(e){broken=true}if(broken){try{Object.defineProperty(window,n,{value:make(),configurable:true,writable:true})}catch(e){}}})})();true;`;
