# Model Context Protocol (MCP)

Tool Use & Function Calling described a model requesting a tool call, and an application executing it. That leaves one problem unsolved: historically, every application wiring an agent up to its own tools had to write custom glue code for each tool, for each model provider. MCP is a standard protocol built specifically to remove that duplication.

## The problem: every tool integration was bespoke

Before a shared standard existed, connecting an agent to a database, a file system, or a third-party API meant writing integration code specific to that exact combination of tool and agent framework.

This creates what's sometimes called an *N tools × M frameworks* problem: every new tool needs its own glue code for every framework it should work with, and every new framework needs its own glue code for every tool it should support. The number of integrations you need grows fast.

## What MCP actually standardizes

MCP defines a shared protocol between two roles: an **MCP client** (the application or agent that wants to use tools and data) and an **MCP server** (a lightweight adapter that exposes one specific system's tools, data, or resources, in the protocol's standard format).

Any MCP-compliant client can talk to any MCP-compliant server, with no custom glue code needed. This is the same kind of integration-simplifying idea as a standard network protocol (Client-Server Model & Networking Basics), letting unrelated pieces of software work together — or a standard API style (Communication Styles), letting unrelated clients call unrelated services. MCP just applies that same idea specifically to connecting agents to tools and data.

<div class="diagram-wrap">
<svg viewBox="0 0 620 220" width="620" height="220" role="img" aria-label="Before MCP, each agent framework needed custom glue code for each tool. After MCP, any MCP client talks to any MCP server through one shared protocol.">
  <text x="20" y="20" class="d-label" font-size="11">before: custom glue per pair</text>
  <rect x="20" y="35" width="90" height="30" rx="5" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="55" text-anchor="middle" class="d-actor-label" font-size="10">Agent A</text>
  <rect x="20" y="80" width="90" height="30" rx="5" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="100" text-anchor="middle" class="d-actor-label" font-size="10">Agent B</text>
  <rect x="220" y="35" width="90" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
  <text x="265" y="55" text-anchor="middle" class="d-actor-label" font-size="10">Database</text>
  <rect x="220" y="80" width="90" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
  <text x="265" y="100" text-anchor="middle" class="d-actor-label" font-size="10">File system</text>
  <line x1="110" y1="50" x2="220" y2="50" class="d-lifeline"></line>
  <line x1="110" y1="50" x2="220" y2="95" class="d-lifeline"></line>
  <line x1="110" y1="95" x2="220" y2="50" class="d-lifeline"></line>
  <line x1="110" y1="95" x2="220" y2="95" class="d-lifeline"></line>
  <text x="165" y="120" text-anchor="middle" class="d-label-muted" font-size="9">4 bespoke integrations</text>
  <text x="20" y="155" class="d-label" font-size="11">after: one shared protocol</text>
  <rect x="20" y="170" width="90" height="30" rx="5" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="190" text-anchor="middle" class="d-actor-label" font-size="10">Any MCP client</text>
  <line x1="110" y1="185" x2="220" y2="185" class="d-msg d-request" marker-end="url(#arrowMcp1)"></line>
  <text x="165" y="178" text-anchor="middle" class="d-label-muted" font-size="9">MCP</text>
  <rect x="220" y="170" width="90" height="30" rx="5" class="d-actor-box" data-role="compute"></rect>
  <text x="265" y="190" text-anchor="middle" class="d-actor-label" font-size="10">Any MCP server</text>
  <defs>
    <marker id="arrowMcp1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">Without a shared protocol, every agent needs bespoke glue for every tool it connects to. MCP standardizes that connection so one client implementation works against any compliant server, and vice versa.</div>
</div>

## What an MCP server actually exposes

An MCP server exposes some combination of three things: **tools** (callable functions, using the same schema-and-arguments shape covered in Tool Use & Function Calling), **resources** (readable data — files, records, documents an agent can pull into its context), and **prompts** (reusable prompt templates for interacting with that particular system).

The model itself still works exactly as described in Tool Use & Function Calling and Agents. MCP doesn't change how the model decides what to call — it only changes how the application connects the model to a much wider, standardized set of things it's able to call.

## Why this matters for system design

MCP solves a standardization problem — it isn't a model capability at all. It's the same category of problem a standard API style solves for services in general (Communication Styles), just applied to the specific surface where agents connect to tools and data.

Adopting it is a build-vs-integrate decision, like any other in this course. Writing a custom tool integration is faster for a single, one-off connection. An MCP server pays off once more than one agent or client needs to reach the same system — the same trade-off that decides when to adopt a standard protocol over a one-off custom one, anywhere else in a system's design.

## Real-world examples

- **Anthropic's Model Context Protocol** — introduced in late 2024, and since adopted by multiple agent frameworks and model providers as a shared standard.
- **Community and vendor-built MCP servers** for common systems (GitHub, Slack, Postgres, file systems) — the same "someone builds the adapter once, everyone reuses it" pattern as an open-source database driver or SDK.
- **Claude Code, Claude Desktop, and other MCP clients** — applications that can connect to any MCP server without needing custom per-tool integration code.
