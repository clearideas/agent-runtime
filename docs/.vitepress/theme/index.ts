import { inBrowser, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "@clearideas/consent-analytics/consent.css";
import DocumentationLayout from "./layout";

import { initializeDocumentationAnalytics } from "./analytics";
import "./style.css";

const theme: Theme = {
  extends: DefaultTheme,
  Layout: DocumentationLayout,
  enhanceApp({ router }) {
    if (inBrowser) {
      void initializeDocumentationAnalytics(router);
    }
  },
};

export default theme;
