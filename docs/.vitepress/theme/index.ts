import { inBrowser, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

import { initializeDocumentationAnalytics } from "./analytics";
import "./style.css";

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (inBrowser) {
      void initializeDocumentationAnalytics(router);
    }
  },
};

export default theme;
