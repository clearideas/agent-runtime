import type { Router } from "vitepress";

type Analytics = {
  flush: () => void;
};

type AnalyticsModule = {
  DEFAULT_CONFIG: Record<string, unknown>;
  initAnalytics: (
    config: Record<string, unknown>,
    adapter: AnalyticsAdapter,
  ) => Analytics;
};

type AnalyticsAdapter = {
  getConfig: () => Record<string, unknown>;
  getCurrentPath: () => string;
  getCurrentUrl: () => string;
  getReferrer: () => string;
  onRouteChange: (callback: (path: string) => void) => () => void;
  onAppReady: (callback: () => void) => void;
  onAppDestroy: (callback: () => void) => () => void;
  showConsentBanner: (onAccept: () => void, onReject: () => void) => void;
  getRouter: () => Router;
};

const analyticsModuleUrl = "/assets/analytics/clearideas-analytics-1.16.11.js";
const productionHostname = "agent-runtime.clearideas.com";

const showConsentBanner: AnalyticsAdapter["showConsentBanner"] = (
  onAccept,
  onReject,
) => {
  if (document.getElementById("ci-consent-banner")) return;

  const banner = document.createElement("section");
  banner.id = "ci-consent-banner";
  banner.setAttribute("aria-label", "Cookie preferences");
  banner.innerHTML = `
    <div class="ci-consent-content">
      <div class="ci-consent-copy">
        <strong>Help us improve your experience</strong>
        <p>
          We use cookies and similar technologies to operate essential features
          and understand how the documentation is used. Read our
          <a href="https://clearideas.com/privacy">Privacy Policy</a>.
        </p>
      </div>
      <div class="ci-consent-actions">
        <button id="ci-consent-reject" type="button">Reject non-essential</button>
        <button id="ci-consent-accept" class="primary" type="button">Accept all</button>
      </div>
    </div>
  `;

  const close = (callback: () => void) => {
    banner.remove();
    callback();
  };

  banner
    .querySelector("#ci-consent-reject")
    ?.addEventListener("click", () => close(onReject));
  banner
    .querySelector("#ci-consent-accept")
    ?.addEventListener("click", () => close(onAccept));
  document.body.appendChild(banner);
};

export const initializeDocumentationAnalytics = async (
  router: Router,
): Promise<void> => {
  if (window.location.hostname !== productionHostname) return;

  try {
    const analyticsModule = (await import(
      /* @vite-ignore */ analyticsModuleUrl
    )) as AnalyticsModule;
    const routeListeners = new Set<(path: string) => void>();
    const previousAfterRouteChange = router.onAfterRouteChange;

    router.onAfterRouteChange = async (to) => {
      await previousAfterRouteChange?.(to);
      const path = new URL(to, window.location.href).pathname;
      for (const listener of routeListeners) {
        listener(path);
      }
    };

    const config = {
      ...analyticsModule.DEFAULT_CONFIG,
      apiBaseUrl: "https://api.clearideas.com",
      eventSiteName: "ci-agent-runtime-docs",
      websiteBaseUrl: "https://clearideas.com/",
      chatEnabled: false,
      debug: false,
      nodeEnv: "production",
    };

    const adapter: AnalyticsAdapter = {
      getConfig: () => config,
      getCurrentPath: () => window.location.pathname,
      getCurrentUrl: () => window.location.href,
      getReferrer: () => document.referrer,
      onRouteChange(callback) {
        routeListeners.add(callback);
        return () => routeListeners.delete(callback);
      },
      onAppReady(callback) {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", callback, {
            once: true,
          });
        } else {
          window.setTimeout(callback, 0);
        }
      },
      onAppDestroy(callback) {
        window.addEventListener("beforeunload", callback);
        return () => window.removeEventListener("beforeunload", callback);
      },
      showConsentBanner,
      getRouter: () => router,
    };

    const analytics = analyticsModule.initAnalytics(config, adapter);
    window.addEventListener("pagehide", () => analytics.flush(), {
      once: true,
    });
  } catch (error) {
    console.warn("Documentation analytics could not be initialized.", error);
  }
};
