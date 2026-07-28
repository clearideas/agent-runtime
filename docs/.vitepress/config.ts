import { defineConfig } from "vitepress";

const base = "/";

export default defineConfig({
  base,
  title: "Clear Ideas Agent Runtime",
  description:
    "A standalone TypeScript runtime for portable, declarative agents with native authorization, sandboxing, and durable execution.",
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
        rel: "icon",
        type: "image/x-icon",
        href: `${base}assets/icons/favicon.ico`,
      },
    ],
    [
      "link",
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: `${base}assets/icons/apple-touch-icon.png`,
      },
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: `${base}assets/icons/favicon-32x32.png`,
      },
    ],
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: `${base}assets/icons/favicon-16x16.png`,
      },
    ],
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
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/clearideas/agent-runtime",
      },
    ],
    editLink: {
      pattern:
        "https://github.com/clearideas/agent-runtime/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
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
          { text: "Interactive example", link: "/interactive-example" },
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
