<template>
  <footer class="site-footer" aria-label="Project information">
    <p>© 2026 <a href="https://clearideas.com/">Clear Ideas Incorporated</a></p>
    <nav aria-label="Project links">
      <a href="https://github.com/clearideas/agent-runtime/blob/main/LICENSE"
        >Apache-2.0 License</a
      >
      <a href="https://github.com/clearideas/agent-runtime">GitHub</a>
      <a href="#ci-consent-settings" data-ci-consent-settings
        >Cookie settings</a
      >
    </nav>
  </footer>
</template>

<style scoped>
.site-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-top: 32px;
  padding: 24px 0;
  border-top: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.6;
}
.site-footer p {
  margin: 0;
}
.site-footer nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.site-footer a {
  color: inherit;
  text-decoration: none;
  text-underline-offset: 3px;
}
.site-footer a:hover {
  text-decoration: underline;
}
.site-footer a:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
</style>
