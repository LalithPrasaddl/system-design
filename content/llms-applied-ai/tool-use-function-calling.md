# Tool Use & Function Calling

Every topic so far has treated the model as something that only reads text in and writes text back out. Tool use breaks that boundary. It lets a model trigger real code — a database query, an API call, a calculation — as part of producing its answer. It's also the foundation that both Agents and MCP are built directly on top of.

## The core mechanism

The application gives the model a list of available **tools** (sometimes called **functions**). Each tool is described by a name, a plain-language description of what it does, and a schema describing what arguments it expects — the same kind of contract as an API endpoint's request schema (Communication Styles).

When the model decides that answering the current prompt requires one of these tools, it doesn't write a normal text response. Instead, it returns a structured request: which tool to call, and with what arguments, matching that schema exactly.

Here's the important part: the application — not the model — is what actually executes the call. The model itself never runs any code. It only ever asks for something to be run.

<div class="diagram-wrap">
<svg viewBox="0 0 620 210" width="620" height="210" role="img" aria-label="A tool-calling round trip: the application sends a prompt and tool schemas to the model, the model returns a structured tool call instead of text, the application executes the real function and sends the result back, and the model uses it to produce the final answer">
  <rect x="15" y="20" width="110" height="36" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="70" y="42" text-anchor="middle" class="d-actor-label" font-size="12">Application</text>
  <rect x="480" y="20" width="120" height="36" rx="6" class="d-actor-box" data-role="compute"></rect>
  <text x="540" y="42" text-anchor="middle" class="d-actor-label" font-size="12">Model</text>
  <line x1="125" y1="38" x2="476" y2="38" class="d-msg d-request" marker-end="url(#arrowTu1)"></line>
  <text x="300" y="30" text-anchor="middle" class="d-label-muted" font-size="10">prompt + available tool schemas</text>
  <line x1="480" y1="60" x2="129" y2="60" class="d-msg d-response" marker-end="url(#arrowTu2)"></line>
  <text x="300" y="76" text-anchor="middle" class="d-label-muted" font-size="10">structured call: get_weather(city="Austin")</text>
  <rect x="60" y="90" width="480" height="34" rx="6" class="d-note"></rect>
  <text x="300" y="111" text-anchor="middle" class="d-note-text" font-size="11">Application executes the real function — model runs no code itself</text>
  <line x1="125" y1="140" x2="476" y2="140" class="d-msg d-request" marker-end="url(#arrowTu3)"></line>
  <text x="300" y="132" text-anchor="middle" class="d-label-muted" font-size="10">tool result: {"temp": 91, "condition": "sunny"}</text>
  <line x1="480" y1="162" x2="129" y2="162" class="d-msg d-response" marker-end="url(#arrowTu4)"></line>
  <text x="300" y="178" text-anchor="middle" class="d-label-muted" font-size="10">final text answer, grounded in the tool result</text>
  <defs>
    <marker id="arrowTu1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowTu2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path></marker>
    <marker id="arrowTu3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowTu4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">The model never touches a database or an API directly — it only ever produces a structured request describing what it wants called. The application stays fully in control of what code actually runs.</div>
</div>

## Why this needed dedicated support

Before this was a built-in model capability, getting a model to trigger an external action meant asking it to describe that action in free-form text, and then writing fragile code to extract its intent from that prose. This was unreliable, and a poor fit for the structured output most application code actually needs.

Tool use replaced that entirely: the model produces arguments that are constrained to a defined schema, directly. It's the same reliability jump that structured output (Prompting & Context Engineering) provides in general, just applied specifically to taking actions rather than just formatting a response.

## Why this matters for system design

Tool use is what turns an LLM from "just a text generator" into a component that can actually participate in a system's data flow — reading from a database, calling an internal API, checking real-time data that no training corpus could ever contain.

The application still owns every trust and security boundary a normal system does (Security & Authentication). A tool call is just a request. The application chooses whether and how to actually execute it — it isn't an instruction the application is obligated to blindly trust, exactly the same way an API server never blindly trusts whatever a client sends it.

## Real-world examples

- **OpenAI, Anthropic, Gemini function-calling APIs** — the exact mechanism described above, offered directly as an API feature by every major model provider.
- **JSON Schema** — the format nearly all of these APIs use to describe a tool's expected arguments.
- **Code-execution tools** (a sandboxed Python interpreter a model can call) — the same mechanism, applied to letting a model run its own generated code, instead of calling a fixed predefined function.
