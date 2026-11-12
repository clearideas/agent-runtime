import type { Router } from "vitepress";

export const initializeDocumentationAnalytics = async (
  router: Router,
): Promise<void> => {
  const siteKey = import.meta.env.VITE_ANALYTICS_SITE_KEY || "ci-docs";
  if (
    window.location.hostname !== "agent-runtime.clearideas.com" &&
    !import.meta.env.VITE_ANALYTICS_SITE_KEY
  )
    return;

  const { initBrowserAnalytics } =
    await import("@clearideas/consent-analytics/browser");
  const analytics = initBrowserAnalytics(
    {
      apiBaseUrl:
        import.meta.env.VITE_ANALYTICS_API_BASE_URL ||
        "https://api.clearideas.com",
      siteKey,
      websiteBaseUrl: "https://clearideas.com/",
      chatEnabled: false,
      banner: { injectStyles: false },
    },
    { routeChanges: "manual" },
  );
  const previous = router.onAfterRouteChange;
  router.onAfterRouteChange = async (to) => {
    await previous?.(to);
    analytics.notifyRouteChange();
  };
  window.addEventListener("pagehide", () => analytics.flush());
};
