// Nothing leaves a self-hosted demo unless its operator enables the collector.
async function startAnalytics() {
  const response = await fetch("/api/browser-analytics");
  if (!response.ok) return;
  const config = await response.json();
  if (!config.enabled) return;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/vendor/consent-analytics.css";
  document.head.append(stylesheet);
  const footer = document.createElement("footer");
  footer.className = "consent-footer";
  const settings = document.createElement("a");
  settings.href = "#ci-consent-settings";
  settings.textContent = "Cookie settings";
  settings.setAttribute("data-ci-consent-settings", "");
  footer.append(settings);
  document.body.append(footer);
  window.ciAnalyticsConfig = {
    banner: { injectStyles: false },
    chatEnabled: false,
    websiteBaseUrl: "https://clearideas.com/",
  };
  const script = document.createElement("script");
  script.src = "/vendor/consent-analytics.js";
  script.dataset.apiBaseUrl = config.apiBaseUrl;
  script.dataset.siteKey = config.siteKey;
  script.addEventListener("error", () => footer.remove(), { once: true });
  document.body.append(script);
}
void startAnalytics().catch(() =>
  console.warn("Showcase consent analytics could not be initialized."),
);
