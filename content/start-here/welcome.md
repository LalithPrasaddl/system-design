# Welcome

System design is the discipline of deciding how the pieces of a software system fit together so it actually works at scale: handles real traffic, survives failures, and stays fast as more people use it.

This course is built for a general audience — no prior system design experience is assumed. If you can write basic code and have used a website or app, you have enough context to start.

## The approach

Each topic explains the underlying mechanics — what's actually happening on the wire, on disk, and across machines — not just a memorized rule of thumb. The goal is that when you encounter a system that doesn't fit a pattern you've seen before, you can still reason about it from first principles: what is this system optimizing for, and what is it trading away to get it?

## How the course is organized

1. **Foundations** — the vocabulary and mental models everything else builds on: how computers talk to each other, what latency and throughput really mean, how services communicate.
2. **Building Blocks** — the components you combine to design real systems: caching, load balancing, databases, replication, partitioning, queues, consensus, and more. Some topics include an optional **"go deeper"** branch for the mechanism behind the component, beyond what's needed to use it well in a design.
3. **Case Studies** — applying the building blocks to real systems, starting from the smallest possible version of each system and adding pieces as its scale requirements grow.
4. **Wrap-Up** — a framework for reasoning about trade-offs under ambiguity, plus a glossary.

## How to use it

- Go in order the first time through — later sections assume earlier ones.
- The sidebar tracks your progress automatically. It's stored in your browser, not on a server, so it's private to your device.
- "Go deeper" branches are optional. Skip them on a first pass and come back later.

Start with [Client-Server Model & Networking Basics](#/client-server-networking).
