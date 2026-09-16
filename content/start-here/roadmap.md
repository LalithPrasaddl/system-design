# Course Map

Here's the full path this course takes, start to finish.

## 1. Foundations
The vocabulary and mental models everything else depends on.
- Client-Server Model & Networking Basics
- Latency, Throughput, and the Numbers Everyone Should Know
- Communication Styles: REST, RPC, GraphQL, Sync vs Async

## 2. Building Blocks
The components you combine to design real systems.
- Scaling Fundamentals
- Service Decomposition
- Load Balancing
- Caching
- Databases I — Relational Fundamentals
- Databases II — NoSQL Models
- Replication
- Partitioning & Sharding
- Multi-Region & Disaster Recovery
- Consistency Models & CAP/PACELC
  - *Go deeper:* Consensus (Raft/Paxos)
- Distributed Locking & Leader Election
- Message Queues & Event-Driven Architecture
  - *Go deeper:* Log-Based Systems (Kafka Internals)
- Batch vs. Stream Processing
- Idempotency & Exactly-Once Delivery
- Storage Engines
  - *Go deeper:* LSM-Trees vs B-Trees
- Rate Limiting & Backpressure
- Security & Authentication
- Search & Indexing at Scale
- Observability

## 3. Frontend Building Blocks
The same kind of components as above, but on the client side of the request.
- Rendering Strategies
- Critical Rendering Path & Performance
- Client-Side Data & Caching
- Client-Side Storage
- CDNs & Edge Delivery
- Real-Time Delivery
- Offline & Resilience
- Backend-for-Frontend & API Shape
- Frontend Security
- Micro-Frontends & Multi-Team Scaling

## 4. Wrap-Up
- A Framework for Reasoning Under Ambiguity
- Glossary

---

Whole systems, built up from the smallest working version to a design that holds under scale — a URL shortener, a rate limiter, a chat system, a news feed, a distributed cache, a ride-hailing dispatch system, a video-streaming platform, and more — are their own track: [System Design Case Studies](#/systems-case-studies/url-shortener). Each one is interactive: you can follow a request through the system one step at a time, and break individual components to see what depends on them. They lean on everything above, so the two tracks are best read alongside each other.

The mechanics behind LLM-based products — training, serving, retrieval, tools, and agents — are covered in their own track: [AI & LLMs](#/ai/llm-vocabulary).
