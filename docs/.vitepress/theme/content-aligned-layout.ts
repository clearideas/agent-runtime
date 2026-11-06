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

/** Keep the brand aligned with the main content area before its inner text padding, including aside/route changes. */
export default defineComponent({
  setup() {
    const route = useRoute();
    let observer: ResizeObserver | undefined;
    let frame = 0;
    const update = () => {
      const content = document.querySelector(".VPDoc > .container > .content");
      const style = document.documentElement.style;
      if (content)
        style.setProperty(
          "--docs-content-left",
          `${content.getBoundingClientRect().left}px`,
        );
      else style.removeProperty("--docs-content-left");
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observeContent = () => {
      if (!observer) return;
      observer.disconnect();
      observer.observe(document.documentElement);
      const content = document.querySelector(".VPDoc > .container > .content");
      if (content) observer.observe(content);
      schedule();
    };
    onMounted(() => {
      observer = new ResizeObserver(schedule);
      observeContent();
      window.addEventListener("resize", schedule);
    });
    watch(
      () => route.path,
      () => void nextTick(observeContent),
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
