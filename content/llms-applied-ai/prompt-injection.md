# Prompt Injection & the Agent Attack Surface

Tool Use & Function Calling, Agents, and MCP together describe a system that reads outside content and takes real actions. This page is about what that combination exposes, and why it's the hardest unsolved problem in shipping agents.

## The root cause: instructions and data arrive on the same channel

A model receives one flat sequence of tokens. Your system prompt, the user's message, a retrieved document, a tool's output — all of it arrives as text, in the same stream, with nothing structurally marking which part is trusted.

The model has no channel separation to fall back on. It was trained to follow instructions that appear in its context, and text pulled off a web page sits in that context next to your own instructions, looking much the same.

**Prompt injection** is the attack that follows: getting the model to treat attacker-supplied text as instructions rather than as content.

The comparison to SQL injection is useful right up to the point where it stops. Both are confusion between code and data. But SQL injection has a real fix — parameterized queries put the query and the values on genuinely separate channels, and the problem goes away. There is no equivalent for prompts. There's no escaping syntax, no prepared-statement form. The separation the fix depends on doesn't exist.

## Direct and indirect injection

**Direct injection** is a user typing something adversarial into your product themselves — attempting to talk the model out of its instructions. This matters, but the blast radius is usually the attacker's own session.

**Indirect injection** is the dangerous one. The payload is planted in content the model will read later: a web page, a PDF, a code comment, a support ticket, a calendar invite, a tool's response. The attacker never touches your system. They write text somewhere your agent will eventually go looking, and wait.

<div class="diagram-wrap">
<svg viewBox="0 0 620 285" width="620" height="285" role="img" aria-label="An indirect prompt injection: a user asks an agent to summarize a page, the page contains hidden instructions, and the agent then reads private data and sends it to an attacker">
  <rect x="15" y="25" width="105" height="44" rx="8" class="d-actor-box" data-role="client"></rect>
  <text x="67" y="45" text-anchor="middle" class="d-actor-label" font-size="12">User</text>
  <text x="67" y="60" text-anchor="middle" class="d-label-muted" font-size="9">"summarize this page"</text>
  <rect x="245" y="25" width="140" height="44" rx="8" class="d-actor-box" data-role="compute"></rect>
  <text x="315" y="45" text-anchor="middle" class="d-actor-label" font-size="12">Agent</text>
  <text x="315" y="60" text-anchor="middle" class="d-label-muted" font-size="9">holds user's credentials</text>
  <rect x="490" y="25" width="115" height="44" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="547" y="45" text-anchor="middle" class="d-actor-label" font-size="12">Web page</text>
  <text x="547" y="60" text-anchor="middle" class="d-label-muted" font-size="9">attacker-controlled</text>
  <line x1="122" y1="40" x2="243" y2="40" class="d-msg d-request" marker-end="url(#arrowPi1)"></line>
  <text x="182" y="33" text-anchor="middle" class="d-label-muted" font-size="9">1</text>
  <line x1="387" y1="40" x2="488" y2="40" class="d-msg d-request" marker-end="url(#arrowPi2)"></line>
  <text x="437" y="33" text-anchor="middle" class="d-label-muted" font-size="9">2. fetch</text>
  <line x1="488" y1="60" x2="387" y2="60" class="d-msg d-response" marker-end="url(#arrowPi3)"></line>
  <text x="437" y="76" text-anchor="middle" class="d-label-muted" font-size="9">page text</text>
  <rect x="400" y="95" width="205" height="38" rx="6" class="d-note"></rect>
  <text x="502" y="110" text-anchor="middle" class="d-note-text" font-size="10">hidden in the page, as ordinary text:</text>
  <text x="502" y="125" text-anchor="middle" class="d-note-text" font-size="10">instructions addressed to the model</text>
  <line x1="290" y1="71" x2="215" y2="193" class="d-msg d-request" marker-end="url(#arrowPi4)"></line>
  <text x="185" y="140" text-anchor="middle" class="d-label-muted" font-size="9">3. reads, using the</text>
  <text x="185" y="152" text-anchor="middle" class="d-label-muted" font-size="9">user's own access</text>
  <line x1="340" y1="71" x2="440" y2="193" class="d-msg d-request" marker-end="url(#arrowPi5)"></line>
  <text x="432" y="140" text-anchor="middle" class="d-label-muted" font-size="9">4. sends it</text>
  <text x="432" y="152" text-anchor="middle" class="d-label-muted" font-size="9">outward</text>
  <rect x="130" y="195" width="170" height="44" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="215" y="215" text-anchor="middle" class="d-actor-label" font-size="12">Private data</text>
  <text x="215" y="230" text-anchor="middle" class="d-label-muted" font-size="9">email, repo, documents</text>
  <rect x="355" y="195" width="170" height="44" rx="8" class="d-actor-box" data-role="routing"></rect>
  <text x="440" y="215" text-anchor="middle" class="d-actor-label" font-size="12">Attacker's server</text>
  <text x="440" y="230" text-anchor="middle" class="d-label-muted" font-size="9">any outbound channel</text>
  <text x="15" y="265" class="d-label-muted" font-size="10">The attacker never contacts the system directly. They plant text where the agent will read it, and the agent does the rest.</text>
  <defs>
    <marker id="arrowPi1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowPi2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowPi3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path></marker>
    <marker id="arrowPi4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
    <marker id="arrowPi5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path></marker>
  </defs>
</svg>
<div class="diagram-caption">Indirect prompt injection. Every step after the fetch is the agent behaving exactly as designed — reading content, deciding what to do, calling its tools.</div>
</div>

## The agent is a confused deputy

Notice what the agent contributed to that attack: its permissions.

The attacker has no access to the user's email or repository. The agent does, because the user gave it that access for legitimate reasons. When the agent acts on injected instructions, it spends the user's authority on the attacker's goal.

This is the **confused deputy** problem, a security pattern much older than LLMs: a privileged component tricked into misusing its privileges for someone who doesn't have them. What's new is only that the trickery is plain English rather than a malformed input.

That framing gives a practical test. Real danger needs three things present at once:

1. Access to something worth taking — private data or a consequential action.
2. Exposure to content somebody else controls.
3. A way for information or effects to reach the outside world.

An agent with all three is exploitable. Remove any one and the attack loses its ending. This is the most useful thing to check when reviewing an agent design, because it's a question about architecture rather than about how clever the prompt was.

## Why filtering doesn't solve it

The obvious response is to detect malicious instructions and strip them out. It helps at the margin and it is not a boundary.

A classifier looking for injected instructions faces an attacker who can rephrase, translate, encode, split the payload across a document, or hide it in formatting the model reads but a reviewer doesn't. Natural language has unbounded ways to express the same intent, which is exactly what makes a filter's job different from validating an email address.

Telling the model to ignore instructions found in documents has the same shape of weakness. It's a request, competing with the attacker's request, resolved by the same mechanism. It raises the effort required. It doesn't change what's possible.

Treat detection as one layer that reduces volume. Don't let anything downstream assume it succeeded.

## What actually works: containment

Since you can't make the model reliably distinguish instructions from data, the defense is to limit what a successful injection can reach.

**Enforce permissions outside the model.** The tool layer checks what this request is allowed to do — the same authorization logic any API endpoint applies (Security & Authentication). A model asking to delete a record proves nothing about whether it may. Nothing in the prompt should be load-bearing for access control.

**Scope credentials to the task.** An agent summarizing a public page needs no mailbox access. Broad standing permissions are what turn a successful injection into a serious one.

**Break the trifecta deliberately.** If an agent must read untrusted content, be careful about what else it holds in the same session and what outbound paths it has. Restricting where results can be sent — allowlisted destinations, no arbitrary outbound requests, no auto-rendered remote images — removes the exfiltration step even when the injection lands.

**Put a human on irreversible actions.** Sending mail, moving money, force-pushing, deleting. Agents already need step limits and approval gates for the reasons in Agents; injection makes the same controls load-bearing for security.

**Treat model output as untrusted input.** Anything the model emits may have been shaped by attacker text. If output reaches a shell, a query, a browser, or another agent, it needs the validation you'd apply to input from a stranger — because that's what it might be.

## Why this matters for system design

This is a familiar problem wearing new clothes. A component processes input from an untrusted source and holds privileges the source doesn't. Systems design has answered that shape for decades: least privilege, defense in depth, validation at every boundary, and a blast radius small enough to survive.

What's different is only that the untrusted input is prose, so no amount of parsing makes it safe. That removes the input-validation answer and leaves the architectural ones. Designs that assume the model will behave correctly under adversarial text are the ones that fail; designs that stay safe when it doesn't are the ones that hold.

The question to ask of an agent design isn't whether the prompt is robust. It's what an attacker gets if the model does exactly what they asked.

## Real-world examples

- **OWASP Top 10 for LLM Applications** — lists prompt injection as LLM01, the top-ranked risk for LLM systems.
- **Simon Willison** named and documented prompt injection in September 2022, and later described the "lethal trifecta" — private data, untrusted content, and external communication — as the combination that makes an agent exploitable.
- **"Not what you've signed up for"** (Greshake et al., 2023) — the paper that demonstrated indirect prompt injection against real deployed LLM applications, planting instructions in web content rather than typing them in.
- **Markdown image exfiltration** — a recurring bug class across many assistants: the model is induced to emit an image pointing at an attacker's server with data in the URL, and the client leaks it by rendering the image. The standard fixes are destination allowlists and not auto-loading remote images — both containment, not detection.
- **Coding agents reading repository content** — issues, pull request descriptions, dependency READMEs and code comments are all attacker-writable on a public repo, and all end up in an agent's context.
