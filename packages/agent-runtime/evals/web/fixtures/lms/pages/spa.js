// SPA do curso: body vazio no início, hidratação com atraso (700 ms), roteamento por pushState,
// acordeão exclusivo com conteúdo preguiçoso (fetch de 400 ms ao expandir).
(function () {
	const app = document.getElementById("app");
	const HYDRATE_DELAY_MS = 700;
	const el = (tag, attrs, ...children) => {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
		for (const child of children) node.append(child);
		return node;
	};
	const parseRoute = () => {
		const match = location.pathname.match(/^\/course\/([^/]+)(\/about)?\/?$/);
		return match ? { id: match[1], about: Boolean(match[2]) } : null;
	};
	const getJson = (url) => fetch(url).then((r) => r.json());

	async function render() {
		const route = parseRoute();
		app.replaceChildren();
		if (!route) return;
		const course = await getJson("/api/course/" + route.id);
		document.title = (route.about ? "About - " : "Course - ") + course.name;
		const nav = el("nav", {},
			el("a", { href: "/courses" }, "All courses"),
			el("a", { href: "/course/" + route.id, "data-link": "" }, "Weeks"),
			el("a", { href: "/course/" + route.id + "/about", "data-link": "" }, "About this course"));
		const header = el("h1", {}, course.name);
		if (route.about) {
			app.append(nav, header, el("h2", {}, "About"), el("p", { class: "instructor" }, "Instructor: " + course.instructor));
			return;
		}
		const accordion = el("div", { class: "accordion" });
		const panels = [];
		for (const week of course.weeks) {
			const panel = el("div", { class: "panel" });
			panel.hidden = true;
			const button = el("button", { "aria-expanded": "false", "data-week": String(week.n) }, week.title);
			let loaded = false;
			button.addEventListener("click", async () => {
				const willOpen = button.getAttribute("aria-expanded") !== "true";
				// Exclusivo: abrir uma semana fecha as outras.
				for (const other of panels) {
					other.button.setAttribute("aria-expanded", "false");
					other.panel.hidden = true;
				}
				if (!willOpen) return;
				button.setAttribute("aria-expanded", "true");
				panel.hidden = false;
				if (loaded) return;
				panel.textContent = "Loading...";
				const data = await getJson("/api/course/" + route.id + "/week/" + week.n);
				loaded = true;
				panel.replaceChildren(...renderWeek(data));
			});
			panels.push({ button, panel });
			accordion.append(el("div", { class: "week" }, button, panel));
		}
		app.append(nav, header, accordion);
	}

	function renderWeek(data) {
		const nodes = [el("ul", { class: "content-items" }, ...data.items.map((title) => el("li", { class: "content-item" }, title)))];
		if (data.activity) {
			const card = el("div", { class: "activity-card", role: "button", tabindex: "0" }, el("strong", {}, data.activity.title), el("div", {}, "Open activity"));
			card.addEventListener("click", () => openModal(data.activity));
			nodes.push(card);
		}
		if (data.iframe) nodes.push(el("iframe", { src: data.iframe, title: "Week resource", width: "420", height: "90" }));
		if (data.shadow) {
			const host = el("div", { class: "shadow-host" });
			const root = host.attachShadow({ mode: "open" });
			const text = document.createElement("p");
			text.textContent = data.shadow;
			root.append(text);
			nodes.push(host);
		}
		if (data.comment) nodes.push(el("div", { class: "comment" }, data.comment));
		return nodes;
	}

	function openModal(activity) {
		const close = el("button", { id: "modal-close" }, "Close");
		const backdrop = el("div", { class: "modal-backdrop" },
			el("div", { class: "modal", role: "dialog", "aria-label": activity.title },
				el("h2", {}, activity.title),
				el("p", {}, activity.description),
				el("p", {}, "Due date: " + activity.dueDate),
				el("p", {}, "Points: " + activity.points),
				close));
		close.addEventListener("click", () => backdrop.remove());
		document.body.append(backdrop);
	}

	document.addEventListener("click", (event) => {
		const link = event.target.closest && event.target.closest("a[data-link]");
		if (!link) return;
		event.preventDefault();
		history.pushState({}, "", link.getAttribute("href"));
		render();
	});
	window.addEventListener("popstate", render);
	setTimeout(render, HYDRATE_DELAY_MS);
})();
