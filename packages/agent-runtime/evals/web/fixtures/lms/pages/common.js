// Banner de consentimento: intercepta cliques até ser fechado (localStorage guarda a escolha).
(function () {
	if (localStorage.getItem("consent")) return;
	const box = document.createElement("div");
	box.id = "consent";
	box.innerHTML =
		'<div class="box" role="dialog" aria-label="Cookie preferences"><p>We use cookies to improve this site.</p>' +
		'<button id="consent-reject">Reject non-essential</button> <button id="consent-accept">Accept all</button></div>';
	document.body.appendChild(box);
	function close(choice) {
		localStorage.setItem("consent", choice);
		box.remove();
	}
	box.querySelector("#consent-reject").addEventListener("click", () => close("reject"));
	box.querySelector("#consent-accept").addEventListener("click", () => close("accept"));
})();
