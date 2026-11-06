import { inBrowser, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import ArticleAlignedLayout from "./article-aligned-layout";

import { initializeDocumentationAnalytics } from "./analytics";
import "./style.css";

const theme: Theme = {
  extends: DefaultTheme,
  Layout: ArticleAlignedLayout,
  enhanceApp({ router }) {
    if (inBrowser) {
      void initializeDocumentationAnalytics(router);
    }
  },
};

export default theme;
