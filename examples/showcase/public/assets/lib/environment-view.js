import { h } from "./ui.js";

/** Two short rows: which sandbox is in use, and which model modes work. */
export const environmentRows = (environment) => {
  const { sandbox, live } = environment;
  return [
    h(
      "div.env-row",
      {},
      h("span", { text: "Sandbox" }),
      sandbox.isolated
        ? h("span.chip.ok", {}, h("i"), sandbox.kind)
        : sandbox.kind === "unisolated"
          ? h("span.chip.danger", {}, h("i"), "not isolated")
          : h("span.chip.danger", {}, h("i"), "unavailable"),
    ),
    h(
      "div.env-row",
      {},
      h("span", { text: "Model" }),
      h("span.chip.ok", {}, h("i"), "scripted"),
      live.available
        ? h("span.chip.ok", {}, h("i"), `live · ${live.model}`)
        : h("small", { text: `Live off: ${live.reason}` }),
    ),
  ];
};

/** A clear, calm notice when the unisolated demo fallback is in use. */
export const isolationBanner = (element, environment) => {
  if (!element || environment.sandbox.kind !== "unisolated") return;
  element.replaceChildren(
    h("strong", { text: "Not isolated." }),
    " No bubblewrap or Docker was found, so commands run as normal processes on this computer, in a temporary folder. Install Docker (or bubblewrap on Linux) for a real sandbox.",
  );
  element.hidden = false;
};
