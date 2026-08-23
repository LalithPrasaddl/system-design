# Orchestration & Agent Harnesses

LLM Vocabulary made an important point: the model itself has no memory between calls. Nothing persists unless it's included again in the next request. But conversations still work fine in practice — you don't have to retype your entire chat history every message, and a coding agent doesn't ask you to re-explain the file it just edited two steps ago. Something is doing that work automatically. This page is about that something: the **orchestration layer**, often just called the **harness**.

## What sits between you and the model

Every LLM product you use — a chat app, a coding assistant, a customer support bot — has application code sitting between you and the raw model. This layer is often called the harness, or the orchestrator. It isn't the model itself. It's the code wrapped around the model, responsible for making a single, stateless model call actually feel like an ongoing conversation, or an autonomous agent working through a task.

Claude Code, Codex, ChatGPT's backend, Cursor, and every custom agent framework (Agents mentioned LangGraph and similar) are all specific examples of this same general layer. None of them change how the model itself works underneath. They change what happens around it.

<div class="diagram-wrap">
<svg viewBox="0 0 640 260" width="640" height="260" role="img" aria-label="A harness sits between the user and the model: it assembles the prompt each turn, manages the context budget, drives the tool-calling loop, and stores session state, while the model itself stays stateless">
  <rect x="15" y="110" width="100" height="40" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="65" y="134" text-anchor="middle" class="d-actor-label" font-size="12">You</text>
  <rect x="175" y="20" width="230" height="220" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="290" y="45" text-anchor="middle" class="d-actor-label" font-size="13">Harness</text>
  <text x="290" y="72" text-anchor="middle" class="d-label-muted" font-size="10">assembles the prompt each turn</text>
  <text x="290" y="96" text-anchor="middle" class="d-label-muted" font-size="10">manages the context budget</text>
  <text x="290" y="120" text-anchor="middle" class="d-label-muted" font-size="10">drives the tool-calling loop</text>
  <text x="290" y="144" text-anchor="middle" class="d-label-muted" font-size="10">stores session state</text>
  <rect x="470" y="20" width="150" height="40" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="545" y="44" text-anchor="middle" class="d-actor-label" font-size="12">Model API</text>
  <text x="545" y="12" text-anchor="middle" class="d-label-muted" font-size="9">stateless per call</text>
  <rect x="470" y="200" width="150" height="40" rx="6" class="d-actor-box" data-role="datastore"></rect>
  <text x="545" y="224" text-anchor="middle" class="d-actor-label" font-size="12">Tools / MCP servers</text>
  <line x1="115" y1="128" x2="171" y2="128" class="d-msg d-request" marker-end="url(#arrowOr1)"></line>
  <text x="143" y="120" text-anchor="middle" class="d-label-muted" font-size="9">messages</text>
  <line x1="405" y1="60" x2="466" y2="45" class="d-msg d-request" marker-end="url(#arrowOr2)"></line>
  <text x="435" y="45" text-anchor="middle" class="d-label-muted" font-size="9">prompt</text>
  <line x1="405" y1="190" x2="466" y2="210" class="d-msg d-request" marker-end="url(#arrowOr3)"></line>
  <text x="435" y="205" text-anchor="middle" class="d-label-muted" font-size="9">tool calls</text>
  <defs>
    <marker id="arrowOr1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowOr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowOr3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">The model itself has no memory between calls — the harness is the application code that makes it feel otherwise: reassembling context every turn, managing what fits, running the tool loop, and remembering the session across requests.</div>
</div>

## Assembling the prompt, every single turn

Prompting & Context Engineering described what goes into a prompt: a system prompt, conversation history, retrieved context, the user's input. The harness is the thing that actually assembles all of that, from scratch, on every single turn — because the model has no memory of its own to draw on.

Concretely: when you send a second message in a conversation, the harness takes your first message, the model's first reply, and your new message, and sends the whole thing back to the model as one request. From the model's point of view, it isn't "continuing a conversation." It's answering a single, self-contained prompt that happens to contain the whole conversation so far.

## Managing the context budget in practice

LLM Vocabulary and Prompting & Context Engineering both describe the context window as a limited budget. The harness is what actually manages that budget as a conversation grows.

A long-running conversation, or a long agent task, will eventually produce more history than fits in the context window. When that happens, the harness has to make a real decision: cut off the oldest messages, summarize older parts of the conversation into a shorter form, or drop tool results that are no longer needed. Different products make this trade-off differently, but every one of them has to make it somehow — there's no way around it once history grows past the limit.

## Driving the loop and running tools

Agents described the reason-act-observe loop. The harness is the code that actually runs that loop: it sends the prompt to the model, reads back a tool call (Tool Use & Function Calling), executes the tool, feeds the result back in, and repeats — deciding after each step whether to continue or stop.

If the harness connects to tools through MCP, it's also acting as the MCP client — the piece responsible for discovering what tools an MCP server offers, and making them available to the model as options it can call.

## Session state and persistence

Beyond a single request, the harness is usually also responsible for storing the conversation or task so far — in memory for a short session, or in a database for something that needs to survive a browser refresh or resume days later. This is ordinary application state management (Databases I — Relational Fundamentals, Client-Side Storage), no different in kind from any other product that needs to remember what a user was doing. It just happens to be state that gets fed back into an LLM's context window, instead of rendered directly to a screen.

## Why this matters for system design

The model is only one component of an LLM-based product, and often not the one where the interesting system design work happens. Prompt assembly, context budget management, the agent loop, tool execution, and session state are all real engineering problems that live in the harness, and they follow the same principles as the rest of this course: manage a limited resource deliberately (Prompting & Context Engineering), bound a loop that could otherwise run forever (Agents), and treat state as something to be stored and retrieved reliably (Databases I — Relational Fundamentals). Knowing where "the model" ends and "the harness" begins is what makes it possible to reason about which of the two is actually responsible when something in an LLM product goes wrong.

## Real-world examples

- **Claude Code, Codex, Cursor** — coding-focused harnesses: each assembles prompts, manages context, drives a tool-calling loop, and persists session state, all around the same kind of underlying model API.
- **ChatGPT, Claude.ai** — chat product harnesses: responsible for conversation history, context trimming or summarization as a conversation grows long, and (in "memory" features) persisting facts across sessions.
- **LangGraph, OpenAI's Agents SDK** — general-purpose harness frameworks: give a team the loop-driving, tool-execution, and state-management scaffolding described above, so they don't have to build it themselves.
