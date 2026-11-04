// Página do viewer: NOSSA página mínima com o motor do noVNC embutido, carregada na WebView por `source={{ html }}`.
// Nenhum HTML vindo da VM é carregado. A CSP só deixa a página abrir o WebSocket do host do servidor salvo.
import { NOVNC_BUNDLE } from "./novnc-bundle.generated";
import { viewerSocketOrigin } from "./viewer-origin";

export { viewerSocketOrigin };

/** CSP da página: nada carrega de fora; scripts e estilos só os inline; conexão só ao WebSocket do servidor. Null se o endereço for inválido. */
export function viewerCsp(serverUrl: string): string | null {
	const origin = viewerSocketOrigin(serverUrl);
	if (!origin) return null;
	return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${origin}; img-src data: blob:`;
}

/**
 * A WebView só pode ficar na nossa página: a única carga permitida é a do próprio HTML (`about:blank`). Qualquer outra
 * navegação (link, redirecionamento, iframe, `data:`, `file:`, http) é recusada.
 */
export function isAllowedViewerNavigation(url: string): boolean {
	return url === "about:blank";
}

/**
 * Código da página que fala com o app (`window.__bridge`). O app só chama estes métodos; a página só manda os eventos de
 * `viewer-bridge.ts` (sem detalhe de erro, sem endereço). Eventos de uma conexão antiga (já trocada) são ignorados.
 */
export const BRIDGE_JS = `(function(){
var target=document.getElementById('screen');var rfb=null;var queue=[];var pumping=false;var waiting=null;var KEY_MAX=0x01110000;
function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o))}catch(e){}}
function stop(){var r=rfb;rfb=null;queue=[];if(r){try{r.disconnect()}catch(e){}}}
function open(url,viewOnly){
stop();
if(!window.NoVNC){waiting=[url,viewOnly];return}
var r;try{r=new window.NoVNC.RFB(target,url,{})}catch(e){post({t:'error'});return}
rfb=r;r.scaleViewport=true;r.clipViewport=false;r.resizeSession=false;r.viewOnly=!!viewOnly;r.showDotCursor=!viewOnly;r.background='#000000';
r.addEventListener('connect',function(){if(rfb===r)post({t:'connected'})});
r.addEventListener('disconnect',function(e){if(rfb!==r)return;rfb=null;post({t:'disconnected',clean:!!(e&&e.detail&&e.detail.clean)})});
r.addEventListener('securityfailure',function(){if(rfb===r)post({t:'securityfailure'})});
r.addEventListener('credentialsrequired',function(){if(rfb===r)post({t:'credentialsrequired'})});
}
function pump(){if(pumping)return;pumping=true;(function step(){var n=0;while(queue.length&&n<24){var k=queue.shift();if(rfb){try{rfb.sendKey(k,null)}catch(e){}}n++}if(queue.length)setTimeout(step,8);else pumping=false})()}
window.__bridge={
ready:function(){post({t:'ready'});if(waiting){var w=waiting;waiting=null;open(w[0],w[1])}},
connect:function(url,viewOnly){if(typeof url==='string')open(url,viewOnly)},
setViewOnly:function(v){if(rfb){rfb.viewOnly=!!v;rfb.showDotCursor=!v}},
keys:function(list){if(!Array.isArray(list))return;for(var i=0;i<list.length&&queue.length<5000;i++){var k=list[i];if(typeof k==='number'&&k>0&&k<KEY_MAX&&Math.floor(k)===k)queue.push(k)}pump()},
disconnect:stop
};
window.onerror=function(){post({t:'error'});return true};
})();`;

const PAGE_CSS = "html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}#screen{position:fixed;left:0;top:0;right:0;bottom:0;background:#000}";

/** HTML completo do viewer para o servidor salvo (CSP, a ponte e o bundle do noVNC), ou null se o endereço do servidor não serve. */
export function buildViewerHtml(serverUrl: string): string | null {
	const csp = viewerCsp(serverUrl);
	if (!csp) return null;
	return [
		"<!doctype html><html><head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
		`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
		`<style>${PAGE_CSS}</style>`,
		'</head><body><div id="screen"></div>',
		`<script>${BRIDGE_JS}</script>`,
		// ESM: o core do noVNC 1.7 usa `await` no topo. O módulo define `window.NoVNC` e chama `__bridge.ready()`.
		`<script type="module">${NOVNC_BUNDLE}</script>`,
		"</body></html>",
	].join("");
}
