import { defineComponent, h } from "vue";
import DefaultTheme from "vitepress/theme";
import ConsentFooter from "./ConsentFooter.vue";

export default defineComponent({
  setup() {
    return () =>
      h(DefaultTheme.Layout, null, { "layout-bottom": () => h(ConsentFooter) });
  },
});
