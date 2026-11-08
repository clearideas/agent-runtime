/**
 * Scripted model answers for Orchestration. No tools here: the interesting
 * parts are the runtime's scheduling, condition, and loops. The critique
 * rejects the first headline, so the goal loop runs twice.
 */
import type { Script } from "../../lib/scripted-model.ts";

const after = (prompt: string, label: string) =>
  new RegExp(`${label}:\\s*(.*)`, "u").exec(prompt)?.[1]?.trim() ?? "";

const pitches: Record<string, string> = {
  blog: "How we gave agents a workspace without handing them the keys.",
  newsletter:
    "New this month: sandboxed workspaces and durable, resumable runs.",
  social:
    "Agents that fix code in a sandbox, pause for approval, and resume later.",
};

export const orchestrationScript: Script = ({ prompt }) => {
  if (prompt.startsWith("Write a two-sentence launch brief"))
    return {
      output:
        "Agent Runtime 0.7.1 lets agents work on real files inside an isolated sandbox under host policy. Runs pause for people or budgets and resume later without losing work.",
    };
  if (prompt.startsWith("Who is the primary audience"))
    return {
      output: "platform teams adding agents to their products",
    };
  if (prompt.startsWith("List launch risks")) {
    const regulated = after(prompt, "Regulated market") === "true.";
    return {
      output: regulated
        ? {
            level: "high",
            items: [
              "Data residency rules for workspace files",
              "Audit requirements for agent actions",
            ],
          }
        : { level: "low", items: ["Documentation gaps at launch"] },
    };
  }
  if (prompt.startsWith("Suggest launch pricing"))
    return {
      output:
        "Open source under Apache 2.0; paid support from $2,000 per month.",
    };
  if (prompt.startsWith("Write a mitigation plan"))
    return {
      output:
        "Keep workspaces in-region, and export every sandbox command record to the customer's audit log.",
    };
  const channel = /Write a one-line (\S+) pitch/u.exec(prompt)?.[1];
  if (channel)
    return { output: pitches[channel] ?? `A ${channel} pitch for the launch.` };
  if (prompt.startsWith("Write a launch headline")) {
    const firstTry = after(prompt, "Previous feedback") === "No review yet.";
    return {
      output: firstTry
        ? "Agent Runtime 0.7.1 is here"
        : "Give your agents a workspace, not the keys",
    };
  }
  if (prompt.startsWith("Critique this headline")) {
    const headline = after(prompt, "Critique this headline strictly");
    return {
      output: headline.includes("is here")
        ? {
            approved: false,
            feedback: "Too generic. Say what changed for the reader.",
          }
        : { approved: true, feedback: "Specific and memorable." },
    };
  }
  if (prompt.startsWith("Assemble the launch plan")) {
    const list = (() => {
      try {
        return (JSON.parse(after(prompt, "Pitches")) as string[])
          .map((pitch) => `- ${pitch}`)
          .join("\n");
      } catch {
        return "";
      }
    })();
    const mitigation = after(prompt, "Mitigation");
    return {
      output: [
        `## ${after(prompt, "Headline")}`,
        "",
        `**Audience:** ${after(prompt, "Audience")}`,
        "",
        `**Pricing:** ${after(prompt, "Pricing")}`,
        ...(mitigation ? ["", `**Risk mitigation:** ${mitigation}`] : []),
        "",
        "**Pitches**",
        "",
        list,
      ].join("\n"),
    };
  }
  return { output: "This prompt is not part of the Orchestration script." };
};
