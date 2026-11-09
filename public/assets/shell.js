// 감탄 운영 화면 공통 왼쪽 사이드바 (정산 · 장부 · 마케팅) + 숨기기.
// PC: 왼쪽 고정, « 버튼으로 아이콘만 남기고 접기(이 브라우저에 기억). 휴대폰: 왼쪽 위 ☰ 버튼으로 열고 닫기.
(() => {
  const ICON = {
    settle: '<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>',
    ledger: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6"/>',
    mkt: '<path d="M4 10v4h3l6 4V6L7 10z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
    fold: '<path d="M15 6l-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  const LINKS = [["/", "정산", "settle"], ["/ledger/", "장부", "ledger"], ["/marketing/", "마케팅", "mkt"]];
  const here = location.pathname;
  const isCur = (href) => (href === "/" ? here === "/" || here === "/index.html" : here.startsWith(href));
  const STORE = "gamtan.sideCollapsed";
  const get = () => { try { return localStorage.getItem(STORE) === "1"; } catch (e) { return false; } };
  const set = (v) => { try { localStorage.setItem(STORE, v ? "1" : "0"); } catch (e) {} };

  const side = document.createElement("aside");
  side.className = "side";
  side.id = "side";
  side.innerHTML =
    `<div class="side-top"><a class="logo" href="/" aria-label="감탄 정산으로"><b>감탄</b><i aria-hidden="true">감</i></a>` +
    `<button type="button" class="side-fold" aria-controls="side">${svg("fold")}</button></div>` +
    `<nav aria-label="화면">` + LINKS.map(([h, t, i]) => `<a href="${h}"${isCur(h) ? ' aria-current="page"' : ""} title="${t}">${svg(i)}<span>${t}</span></a>`).join("") + `</nav>`;
  const burger = document.createElement("button");
  burger.type = "button"; burger.className = "side-burger"; burger.setAttribute("aria-controls", "side"); burger.setAttribute("aria-label", "메뉴 열기"); burger.innerHTML = svg("menu");
  const shade = document.createElement("div"); shade.className = "side-shade";
  document.body.prepend(side, burger, shade);
  document.body.classList.add("has-side");

  const fold = side.querySelector(".side-fold");
  const apply = (collapsed) => {
    document.body.classList.toggle("side-collapsed", collapsed);
    fold.setAttribute("aria-label", collapsed ? "사이드바 펼치기" : "사이드바 숨기기");
    fold.setAttribute("aria-expanded", String(!collapsed));
  };
  apply(get());
  const mobile = () => matchMedia("(max-width:760px)").matches;
  const open = (v) => { document.body.classList.toggle("side-open", v); burger.setAttribute("aria-expanded", String(v)); if (v) side.querySelector("a[aria-current]")?.focus(); };
  fold.addEventListener("click", () => { if (mobile()) return open(false); const c = !document.body.classList.contains("side-collapsed"); apply(c); set(c); });
  burger.addEventListener("click", () => open(true));
  shade.addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("side-open")) { open(false); burger.focus(); } });
})();
