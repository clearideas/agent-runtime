<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { waitForShowcase } from "../../../examples/showcase/launcher/readiness.js";

const endpoint = import.meta.env.VITE_SHOWCASE_URL;
const status = ref("Starting the interactive showcase…");
const ready = ref(false);
const failed = ref(false);
const elapsed = ref(0);
let controller;
const connect = async () => {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  ready.value = false;
  failed.value = false;
  status.value = "Starting the interactive showcase…";
  try {
    const result = await waitForShowcase(endpoint, {
      signal: current.signal,
      onProgress: ({ elapsedMs }) => {
        elapsed.value = Math.floor(elapsedMs / 1000);
      },
    });
    elapsed.value = Math.ceil(result.elapsedMs / 1000);
    status.value = "The showcase is ready.";
    ready.value = true;
  } catch (error) {
    if (current.signal.aborted) return;
    status.value = error.message;
    failed.value = true;
  }
};
onMounted(() => {
  if (endpoint) connect();
});
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section
    v-if="endpoint"
    class="hosted-showcase"
    aria-label="Interactive showcase"
  >
    <div class="showcase-connection" role="status" aria-live="polite">
      <span :class="{ ready, failed }" class="showcase-dot"></span>
      <span>{{ status }}</span>
      <small v-if="!failed">{{ elapsed }}s</small>
      <button v-if="failed" type="button" @click="connect">Try again</button>
      <a
        v-if="ready"
        class="showcase-open"
        :href="endpoint"
        target="_blank"
        rel="noopener"
        >Open in a new tab ↗</a
      >
    </div>
    <p v-if="!ready && !failed">
      The hosted server starts on demand. The first visit may take a little
      longer.
    </p>
    <iframe
      v-if="ready"
      :src="endpoint"
      title="Agent Runtime interactive showcase"
      allow="clipboard-write; fullscreen"
    ></iframe>
  </section>
</template>

<style scoped>
.hosted-showcase {
  margin: 28px 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.showcase-connection {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
.showcase-connection a,
.showcase-connection small {
  font-size: 12px;
}
.showcase-open {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 9px 16px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 6px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  text-decoration: none;
}
.showcase-open:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
  color: var(--vp-c-white);
}
.showcase-open:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
.showcase-connection button {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
.showcase-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #d4a448;
}
.showcase-dot.ready {
  background: #35b68c;
}
.showcase-dot.failed {
  background: #e76471;
}
iframe {
  display: block;
  width: 100%;
  min-height: 1000px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
</style>
