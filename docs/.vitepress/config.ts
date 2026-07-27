import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Clear Ideas Agent Runtime",
  description:
    "Build and run declarative AI agents with your choice of models, tools, storage, and compute.",
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  srcExclude: ["README.md"],
  head: [
    ["meta", { name: "theme-color", content: "#ffffff" }],
    ["meta", { name: "color-scheme", content: "light dark" }],
    [
      "link",
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "anonymous",
      },
    ],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600;1,700&display=swap",
      },
    ],
  ],
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    siteTitle: "Agent Runtime",
    logo: "/clearideas-logo.svg",
    nav: [
      { text: "Guide", link: "/quickstart" },
      { text: "Patterns", link: "/build-agents" },
      { text: "Reference", link: "/reference" },
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quick start", link: "/quickstart" },
          { text: "Core concepts", link: "/concepts" },
          { text: "Build agents", link: "/build-agents" },
        ],
      },
      {
        text: "Build",
        items: [
          { text: "Agent and agent run manifests", link: "/manifests" },
          { text: "Models and providers", link: "/models-and-providers" },
          { text: "Connections and tools", link: "/connections-and-tools" },
          { text: "Embed Agent Runtime", link: "/embedding" },
        ],
      },
      {
        text: "Execution",
        items: [
          { text: "Local execution", link: "/local-execution" },
          { text: "Remote execution", link: "/remote-execution" },
        ],
      },
      {
        text: "Adapters",
        items: [{ text: "Adapter catalog", link: "/adapters" }],
      },
      {
        text: "Capabilities",
        items: [
          { text: "Events and streaming", link: "/events-and-streaming" },
          {
            text: "Persistence and recovery",
            link: "/persistence-and-recovery",
          },
          { text: "Sandboxes and artifacts", link: "/sandboxes-and-artifacts" },
        ],
      },
      {
        text: "Production",
        items: [{ text: "Production guide", link: "/production" }],
      },
      {
        text: "Reference",
        items: [{ text: "Contract reference", link: "/reference" }],
      },
    ],
    search: {
      provider: "local",
      options: {
        detailedView: true,
      },
    },
    outline: {
      level: [2, 3],
      label: "On this page",
    },
    docFooter: {
      prev: "Previous",
      next: "Next",
    },
    lastUpdated: {
      text: "Last updated",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
  },
});
