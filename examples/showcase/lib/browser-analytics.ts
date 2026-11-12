export interface BrowserAnalyticsOptions {
  apiBaseUrl: string;
  siteKey: string;
}
export type BrowserAnalyticsConfig =
  { enabled: false } | (BrowserAnalyticsOptions & { enabled: true });

export function resolveBrowserAnalytics(
  options?: BrowserAnalyticsOptions | false,
  environment: NodeJS.ProcessEnv = process.env,
): BrowserAnalyticsConfig {
  if (options === false) return { enabled: false };
  const apiBaseUrl =
    options?.apiBaseUrl ?? environment.SHOWCASE_ANALYTICS_API_BASE_URL;
  const siteKey = options?.siteKey ?? environment.SHOWCASE_ANALYTICS_SITE_KEY;
  if (!apiBaseUrl && !siteKey) return { enabled: false };
  if (!apiBaseUrl || !siteKey || !/^[A-Za-z0-9._-]{3,64}$/.test(siteKey)) {
    throw new Error(
      "Showcase analytics requires a collector URL and registered site key.",
    );
  }
  const url = new URL(apiBaseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Showcase analytics requires an HTTP(S) collector URL without credentials or query.",
    );
  }
  return { enabled: true, apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""), siteKey };
}
