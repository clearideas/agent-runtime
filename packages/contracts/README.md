# @clearideas/agent-runtime-contracts

TypeScript types, Zod schemas, and parsers for agent manifests and agent run
manifests. `metadata` stores inert application data. Namespaced `extensions`
configure behavior implemented by an application adapter. Unknown manifest
fields fail validation.

Agent run manifests may declare `budget.maxTotalTokens`. Checkpoints persist
the effective limit and cumulative consumed model tokens across attempts.

Variable keys are top-level names. Dot notation reads nested properties from
object values. Paths cannot contain empty, `__proto__`, `prototype`, or
`constructor` segments.
