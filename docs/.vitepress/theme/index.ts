import { inBrowser, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import ContentAlignedLayout from "./content-aligned-layout";

import { initializeDocumentationAnalytics } from "./analytics";
import "./style.css";

const theme: Theme = {
  extends: DefaultTheme,
  Layout: ContentAlignedLayout,
  enhanceApp({ router }) {
    if (inBrowser) {
      void initializeDocumentationAnalytics(router);
    }
  },
};

export default theme;
