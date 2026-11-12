import { showcaseUrl, waitForShowcase } from "./readiness.js";

const element = (id) => document.getElementById(id);
let controller;
const connect = async (event) => {
  event?.preventDefault();
  controller?.abort();
  const current = new AbortController();
  controller = current;
  element("showcase").hidden = true;
  element("showcase").removeAttribute("src");
  element("runtime-info").hidden = true;
  element("indicator").className = "indicator starting";
  element("status").textContent = "Starting the showcase…";
  element("detail").textContent =
    "Connecting to the hosted runtime. The first visit may take a little longer.";
  element("connect").textContent = "Reconnect";
  try {
    const endpoint = showcaseUrl(element("endpoint").value.trim());
    const result = await waitForShowcase(endpoint, {
      signal: current.signal,
      onProgress: ({ elapsedMs }) => {
        element("elapsed").textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
      },
    });
    element("indicator").className = "indicator ready";
    element("status").textContent = "Showcase connected";
    element("detail").textContent =
      `The runtime is ready · ${result.health.sandbox} sandbox · all execution happens on the hosted server.`;
    element("elapsed").textContent = `${(result.elapsedMs / 1000).toFixed(1)}s`;
    element("instance").textContent =
      `Server started ${new Date(result.health.startedAt).toLocaleTimeString()} · instance ${result.health.instanceId.slice(0, 8)}`;
    element("open-showcase").href = endpoint;
    element("runtime-info").hidden = false;
    element("showcase").src = endpoint;
    element("showcase").hidden = false;
  } catch (error) {
    if (current.signal.aborted) return;
    element("indicator").className = "indicator error";
    element("status").textContent = "Could not connect";
    element("detail").textContent = error.message;
    element("connect").textContent = "Try again";
  }
};
element("connection").addEventListener("submit", connect);
window.addEventListener("pagehide", () => controller?.abort());
try {
  const config = await (await fetch("/config.json")).json();
  const endpoint =
    new URLSearchParams(location.search).get("endpoint") ?? config.endpoint;
  if (endpoint) {
    element("endpoint").value = endpoint;
    await connect();
  }
} catch (error) {
  element("detail").textContent = error.message;
}
