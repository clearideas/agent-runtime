import { h } from "./lib/ui.js";
import { environmentRows, isolationBanner } from "./lib/environment-view.js";

// Small static diagrams. Motion is saved for the demos themselves.
const illustrations = {
  "repo-mechanic": `
    <rect class="box" x="40" y="22" width="90" height="76" rx="8"/>
    <rect class="faint" x="52" y="36" width="60" height="6" rx="3"/>
    <rect class="warn" x="52" y="50" width="48" height="6" rx="3"/>
    <rect class="faint" x="52" y="64" width="56" height="6" rx="3"/>
    <rect class="faint" x="52" y="78" width="40" height="6" rx="3"/>
    <path class="line" d="M130 60 H170"/>
    <rect class="box" x="170" y="22" width="110" height="76" rx="8"/>
    <rect class="bad" x="182" y="38" width="70" height="6" rx="3"/>
    <rect class="good" x="182" y="56" width="84" height="6" rx="3"/>
    <rect class="good" x="182" y="74" width="60" height="6" rx="3"/>`,
  "durable-runs": `
    <path class="line" d="M30 60 H290"/>
    <circle class="accent" cx="60" cy="60" r="7"/>
    <circle class="accent" cx="110" cy="60" r="7"/>
    <circle class="accent-stroke" cx="160" cy="60" r="11"/>
    <rect class="warn" x="155" y="54" width="3.5" height="12" rx="1"/>
    <rect class="warn" x="161.5" y="54" width="3.5" height="12" rx="1"/>
    <circle class="good" cx="210" cy="60" r="7"/>
    <circle class="good" cx="260" cy="60" r="7"/>`,
  guardrails: `
    <path class="accent-stroke" d="M160 22 L192 32 L188 72 Q182 92 160 100 Q138 92 132 72 L128 32 Z"/>
    <circle class="bad" cx="90" cy="46" r="6"/>
    <circle class="bad" cx="70" cy="74" r="6"/>
    <path class="line" d="M96 46 H124 M76 74 H124"/>
    <circle class="good" cx="236" cy="60" r="6"/>
    <path class="line" d="M196 60 H230"/>`,
  "document-library": `
    <rect class="box" x="92" y="24" width="40" height="72" rx="5"/>
    <rect class="box" x="140" y="32" width="40" height="64" rx="5"/>
    <rect class="faint" x="188" y="28" width="40" height="68" rx="5"/>
    <rect class="faint" x="104" y="40" width="16" height="4" rx="2"/>
    <rect class="faint" x="152" y="48" width="16" height="4" rx="2"/>`,
  "long-investigation": `
    <path class="bad-stroke" d="M40 30 H290" stroke-dasharray="6 5"/>
    <rect class="accent" x="52" y="78" width="16" height="22" rx="2"/>
    <rect class="accent" x="76" y="64" width="16" height="36" rx="2"/>
    <rect class="accent" x="100" y="48" width="16" height="52" rx="2"/>
    <rect class="violet" x="124" y="66" width="16" height="34" rx="2"/>
    <rect class="accent" x="148" y="52" width="16" height="48" rx="2"/>
    <rect class="accent" x="172" y="38" width="16" height="62" rx="2"/>
    <rect class="violet" x="196" y="64" width="16" height="36" rx="2"/>
    <rect class="accent" x="220" y="50" width="16" height="50" rx="2"/>
    <rect class="accent" x="244" y="38" width="16" height="62" rx="2"/>
    <rect class="violet" x="268" y="62" width="16" height="38" rx="2"/>`,
  orchestration: `
    <path class="line" d="M70 60 C110 60 110 32 150 32 M70 60 C110 60 110 88 150 88 M150 32 C190 32 190 60 230 60 M150 88 C190 88 190 60 230 60"/>
    <circle class="accent-stroke" cx="70" cy="60" r="10"/>
    <circle class="accent-stroke" cx="150" cy="32" r="10"/>
    <circle class="accent-stroke" cx="150" cy="88" r="10"/>
    <circle class="accent-stroke" cx="230" cy="60" r="10"/>`,
};

const illustration = (id) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 120");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ill");
  svg.innerHTML = illustrations[id] ?? "";
  return svg;
};

const card = (entry) => {
  const ready = entry.status === "ready";
  // A demo the installed runtime cannot run still opens: its page says why.
  const opens = ready || entry.status === "unavailable";
  return h(
    `${opens ? "a" : "article"}.card.demo-card`,
    {
      href: opens ? `/demos/${entry.id}` : undefined,
      dataset: { status: entry.status },
      title: entry.unavailable,
    },
    h("div.illustration", {}, illustration(entry.id)),
    h(
      "div.content",
      {},
      h(
        "div.title-row",
        {},
        h("h2", { text: entry.title }),
        ready
          ? h("span.open", { text: "Open →" })
          : entry.status === "unavailable"
            ? h("span.soon", { text: "Needs a newer runtime" })
            : h("span.soon", { text: "Coming soon" }),
      ),
      h("p", { text: entry.summary }),
    ),
  );
};

const [environment, entries] = await Promise.all([
  fetch("/api/environment").then((response) => response.json()),
  fetch("/api/demos").then((response) => response.json()),
]);
document
  .getElementById("environment")
  .replaceChildren(...environmentRows(environment));
isolationBanner(document.getElementById("isolation-banner"), environment);
document.getElementById("gallery").replaceChildren(...entries.map(card));
