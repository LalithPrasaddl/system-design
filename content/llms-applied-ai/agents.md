# Agents

Tool Use & Function Calling covered a single round trip: the model asks for a tool call, the application runs it, the model answers. An **agent** is what happens when that round trip repeats — the model deciding, on its own, to make another tool call based on what the last one returned, and continuing until it decides the task is actually finished.

## The loop: think, act, observe

An agent's core structure is a loop, not a single call. Given a task and a set of available tools, the model:

1. **Reasons** about what to do next.
2. **Acts** by calling a tool.
3. **Observes** the result.

Then — and this is the important part — it decides, based on that result, whether the task is done or whether it needs to act again. It repeats this loop for as many steps as the task actually takes.

A single tool call (Tool Use & Function Calling) is just this loop, run for exactly one round. An agent is the general case: the number of steps isn't fixed in advance, and depends entirely on what each step's result turns out to be.

<div class="diagram-wrap">
<svg viewBox="0 0 500 320" width="500" height="320" role="img" aria-label="The agent loop: reason about the next step, act by calling a tool, observe the result, then either loop back to reason again or stop once the task is done">
  <rect x="170" y="20" width="160" height="50" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="250" y="42" text-anchor="middle" class="d-actor-label" font-size="13">Reason</text>
  <text x="250" y="58" text-anchor="middle" class="d-label-muted" font-size="9">what should happen next?</text>
  <line x1="330" y1="45" x2="400" y2="120" class="d-lifeline" marker-end="url(#arrowAg1)"></line>
  <rect x="340" y="130" width="150" height="50" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="415" y="152" text-anchor="middle" class="d-actor-label" font-size="13">Act</text>
  <text x="415" y="168" text-anchor="middle" class="d-label-muted" font-size="9">call a tool</text>
  <line x1="415" y1="180" x2="330" y2="245" class="d-lifeline" marker-end="url(#arrowAg2)"></line>
  <rect x="170" y="240" width="160" height="50" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="250" y="262" text-anchor="middle" class="d-actor-label" font-size="13">Observe</text>
  <text x="250" y="278" text-anchor="middle" class="d-label-muted" font-size="9">read the tool's result</text>
  <line x1="170" y1="255" x2="70" y2="150" class="d-lifeline" marker-end="url(#arrowAg3)"></line>
  <text x="30" y="205" class="d-label-muted" font-size="10">task not done:</text>
  <text x="30" y="218" class="d-label-muted" font-size="10">loop back to Reason</text>
  <line x1="250" y1="240" x2="250" y2="300" stroke="var(--border)" stroke-dasharray="4,4"></line>
  <text x="250" y="315" text-anchor="middle" class="d-label-muted" font-size="10">task judged done: stop, return final answer</text>
  <defs>
    <marker id="arrowAg1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowAg2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowAg3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">The loop itself is simple; what makes an agent useful (or dangerous) is how many iterations it takes and how much it's trusted to act without a human checking each step.</div>
</div>

## Planning and memory

Beyond the basic loop, most agent frameworks add two more things.

**Planning** means having the model sketch out a rough multi-step plan up front, instead of deciding purely one step at a time. This tends to produce more coherent behavior on tasks that have several steps depending on each other.

**Memory** means carrying relevant information forward across loop iterations — and sometimes across entirely separate sessions. This matters because the context window (LLM Vocabulary) can't hold an unlimited history of everything the agent has done so far.

Both of these are really extensions of ideas already covered in this module. Planning is just structured prompting (Prompting & Context Engineering) aimed at a multi-step task. Memory is a context-budget management problem — the same one RAG solves for outside documents, just applied here to an agent's own running history instead.

## Why an agent's loop needs guardrails an ordinary tool call doesn't

A single tool call (Tool Use & Function Calling) is bounded and easy to reason about: one action, one result. An agent's loop is open-ended by comparison. It can call tools over and over — and a flawed stopping condition, or one misjudged step along the way, can send it down an unproductive or costly path. It might loop without making progress. Worse, it might take a real-world action — sending an email, spending money — that never should have happened.

Production agent systems handle this the same way any system in this course handles an operation that shouldn't run unchecked: hard limits on the number of steps, a human-in-the-loop approval step before any high-consequence tool call, and the same kind of evals and monitoring (Evaluation & Monitoring) already applied to individual model responses — now applied to whether the entire multi-step task actually finished successfully.

## Why this matters for system design

An agent is a system, not just a smarter prompt. It has a control loop, a stopping condition, state carried across steps, and real actions with real consequences through the tools it calls. That means designing an agent pulls in the same concerns this course applies to any other long-running, stateful process: put a bound on retries, isolate failures so they don't cascade, and never let an automated action have a consequence you haven't explicitly authorized it to have.

## Real-world examples

- **ReAct** (Yao et al., 2022) — the paper that named and popularized this reason-then-act loop, which most agent frameworks are built around today.
- **LangGraph, AutoGPT, OpenAI's Agents SDK, Anthropic's agent tooling** — frameworks that provide the loop, planning, and memory scaffolding described above, so teams don't have to build it from scratch.
- **Coding agents** (e.g. Claude Code, GitHub Copilot's agent mode) — a widely used concrete example: the loop plans a change, edits a file (a tool call), runs the tests (another tool call), reads the failure, and loops again.
