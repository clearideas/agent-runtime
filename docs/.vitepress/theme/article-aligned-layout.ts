import {
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  watch,
} from "vue";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";

/** Keep the brand aligned with the rendered article, including aside/route changes. */
export default defineComponent({
  setup() {
    const route = useRoute();
    let observer: ResizeObserver | undefined;
    let frame = 0;
    const update = () => {
      const article = document.querySelector(".VPDoc .content-container");
      const style = document.documentElement.style;
      if (article)
        style.setProperty(
          "--docs-content-left",
          `${article.getBoundingClientRect().left}px`,
        );
      else style.removeProperty("--docs-content-left");
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observeArticle = () => {
      if (!observer) return;
      observer.disconnect();
      observer.observe(document.documentElement);
      const article = document.querySelector(".VPDoc .content-container");
      if (article) observer.observe(article);
      schedule();
    };
    onMounted(() => {
      observer = new ResizeObserver(schedule);
      observeArticle();
      window.addEventListener("resize", schedule);
    });
    watch(
      () => route.path,
      () => void nextTick(observeArticle),
      { flush: "post" },
    );
    onUnmounted(() => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.documentElement.style.removeProperty("--docs-content-left");
    });
    return () => h(DefaultTheme.Layout);
  },
});
