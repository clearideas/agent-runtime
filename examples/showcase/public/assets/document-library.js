/**
 * Document Library page: the shared stage with an MCP service box, a
 * question picker, and a reply that shows any image the model looked at.
 */
import { createDemoPage } from "./lib/demo-page.js";
import { defaultResultText } from "./lib/stage.js";
import { $, h, renderMarkdown } from "./lib/ui.js";

const resultBody = $("#result-body");
const images = new Map();

const renderReply = () => {
  const { result, error } = page.state;
  if (!result) {
    resultBody.replaceChildren(
      h("p.empty", { text: error ?? "Pick a question and run the agent." }),
    );
    return;
  }
  const markdown = h("div.markdown");
  renderMarkdown(markdown, result.output ?? "");
  resultBody.replaceChildren(
    markdown,
    ...[...images].map(([path, url]) =>
      h(
        "figure.artifact",
        {},
        h("img", { src: url, alt: `The image the model received: ${path}` }),
        h("figcaption", {
          text: `${path}, passed to the model as an image artifact (never as text)`,
        }),
      ),
    ),
  );
};

const page = await createDemoPage({
  demoId: "document-library",
  stageOptions: {
    services: [
      { alias: "tickets", title: "Ticket system", subtitle: "MCP server" },
    ],
    resultText: (tool) =>
      tool.name === "tickets__create" && !tool.error
        ? `created ${tool.output?.structuredContent?.id ?? "ticket"}`
        : defaultResultText(tool),
  },
  buildRequest: () => ({
    question: document.querySelector('input[name="question"]:checked')?.value,
  }),
  onReset: () => {
    images.clear();
    renderReply();
  },
  onMessage: (message) => {
    if (message.kind !== "tool-io" || !Array.isArray(message.artifacts)) return;
    for (const artifact of message.artifacts)
      if (artifact.mediaType?.startsWith("image/"))
        images.set(
          message.input?.path ?? artifact.name,
          `/api/demos/document-library/artifacts/${artifact.id}`,
        );
  },
  onEffect: (effect) => {
    if (effect.type === "result" || effect.type === "error") renderReply();
  },
});

$("#questions").replaceChildren(
  ...page.demo.questions.map((question, index) =>
    h(
      "label.question",
      {},
      h("input", {
        type: "radio",
        name: "question",
        value: question,
        checked: index === 0,
      }),
      h("span", { text: question }),
    ),
  ),
);
renderReply();
