# LLM Vocabulary

So far in this course, every system answered a request by looking up or computing an exact result — a row in a database, a value in a cache, a job pulled off a queue. A large language model (LLM) works differently. It doesn't look up an answer — it generates one, piece by piece (more precisely, token by token — more on that in Tokenization). This module covers the systems built around that difference. Start with the basic vocabulary — the rest of the module depends on it.

## AI, ML, and models

**Artificial intelligence (AI)** is the general goal: getting software to do things that normally require human intelligence — understanding language, recognizing images, making decisions.

**Machine learning (ML)** is the main way people build AI today. Instead of a programmer writing explicit rules for every possible situation, the software learns patterns from a large number of examples.

A **model** is the result of that learning. Concretely, it's a huge collection of numbers called **parameters** (or **weights**). During training, these numbers get adjusted, over and over, until feeding the model an input reliably produces a useful output.

A **foundation model** is a model trained once, on a huge and varied amount of data, and then reused afterward for many different jobs — instead of training a brand new model from scratch every time you need something slightly different. You adapt it later, either by fine-tuning it (Fine-Tuning in Practice) or simply by prompting it differently.

An **LLM** — large language model — is a foundation model built specifically for text. Give it some text, and its job is to predict what text comes next.

## Parameter count and what it means

When people talk about a model's "size," they usually mean its parameter count — written as 7B (7 billion parameters), 70B, 400B, and so on.

More parameters generally means the model can capture more patterns from its training data, which usually means better answers. But more parameters also means more computing power is needed — both to train the model in the first place, and to run it afterward.

So model size is a genuine trade-off, not a case of "bigger is always better." A larger model usually costs more money and takes longer to answer each request (Model Serving & Inference Infrastructure covers why). Picking a model size means balancing speed, cost, and quality against each other — the same kind of trade-off you already saw when picking a database or cache tier elsewhere in this course, just applied to a different resource here.

## Base models vs. instruct/chat models

A model that has only gone through pretraining (Training Lifecycle) is called a **base model**. All it knows how to do is predict what text comes next — it doesn't inherently know it's supposed to "answer a question" the way you'd expect a chatbot to.

For example, if you ask a base model "What's the capital of France?", it might just continue with a list of similar geography questions instead of answering "Paris." From the model's point of view, that's simply a very normal way for this kind of text to continue.

An **instruct model** (also called a **chat model**) is that same base model, trained further so it actually follows instructions and holds a conversation the way you'd expect.

Almost every LLM product you've actually used — a chat app, or an API most developers call — is this instruct/chat version. The raw base model is rarely something you interact with directly.

## Context window

The **context window** is the limit on how much text a model can "see" and think about at one time, measured in tokens (Tokenization — a token is roughly a word or a piece of a word).

Everything counts against this same limit: your messages, any earlier messages in the conversation, documents the system feeds in as extra context, and even the model's own reply as it's being generated. It all adds up against one shared budget.

Here's the part that trips people up: the model has no memory of past conversations on its own. Picture talking to someone with no long-term memory — for them to "remember" something you said earlier, you'd have to repeat it back to them every single time. That's exactly how an LLM works. If something isn't included again in the current request, the model has no way of knowing it ever happened.

A bigger context window doesn't remove this limit — it just makes the limit bigger. You can fit more conversation, more documents, more of everything into one request, but there's still a ceiling. Prompting & Context Engineering covers how to manage that ceiling on purpose, instead of assuming you'll never hit it.

## Training vs. inference: two different workloads

This is the split that shapes everything else in this module, so it's worth being very clear about it.

**Training** is the process that produces a model's parameters in the first place. It's extremely expensive: it runs on large clusters of specialized hardware, over days or weeks, and it's usually done once per model (occasionally repeated to produce a new version). Think of it as a one-time, very expensive project with a clear finish line.

**Inference** is what happens every time someone actually uses the trained model to answer a question. Each individual request is relatively cheap. But inference never really "finishes" — it keeps happening, over and over, for as long as the product is in use, at whatever rate real users send requests. It's the same relationship as a program being compiled once, then run many times afterward by many different people, whenever they want.

Training has a finish line. Inference doesn't. Keeping this straight matters, because "how do we make the model better" (a training question) and "how do we make the model answer faster" (an inference/serving question) are two completely different problems that call for completely different work — mixing them up is a common, easy-to-make mistake.

## Why this matters for system design

You've actually seen this shape before in this course: build something expensive once, then serve cheap reads against it many times afterward. Search & Indexing at Scale does exactly this for a search index — building the index is expensive, but looking things up in it afterward is fast and cheap. Training and inference follow the same pattern.

Every topic in this module falls on one side of the training/inference split or the other. Keeping that split clear in your head is what stops you from treating "make the model better" and "make the model answer faster" as the same problem — they aren't, and they need different work to fix.

## Real-world examples

- **GPT-4, Claude, Gemini, Llama** — foundation models, each shipped with distinct base and instruct/chat variants.
- **Hugging Face's model hub** — lists parameter counts and base/instruct variants side by side for thousands of open models.
- **Chinchilla scaling laws** — a well-known finding from DeepMind showing that many early large models were too big for the amount of data they were trained on. It changed how AI labs balance a model's size against how much data they train it on.
