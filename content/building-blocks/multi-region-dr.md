# Multi-Region & Disaster Recovery

Replication covers copying data so a single machine failing doesn't lose or block access to anything. This page is the same idea at a much larger blast radius: what happens when an entire region — a whole datacenter, or everything a cloud provider runs in one geographic area — goes down at once, and how a system survives that.

## Why a region fails as a unit

A power outage, a natural disaster, or a cloud provider's own regional incident (something that happens to every major provider occasionally) takes down every machine in that region simultaneously, no matter how well data is replicated *within* it. Replicating across machines in the same datacenter protects against one machine failing; it does nothing if the datacenter itself loses power.

## Two topologies

<div class="diagram-wrap">
<svg viewBox="0 0 640 200" width="640" height="200" role="img" aria-label="Active-passive replicates one direction from an active region to a standby; active-active replicates both directions between two regions that both accept writes">
  <text x="125" y="54" text-anchor="end" class="d-label" font-size="11">Active-Passive</text>
  <rect x="140" y="30" width="150" height="40" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="215" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Region A · active</text>
  <rect x="440" y="30" width="150" height="40" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="515" y="55" text-anchor="middle" class="d-actor-label" font-size="12">Region B · standby</text>
  <line x1="290" y1="50" x2="436" y2="50" class="d-msg d-request" marker-end="url(#arrowDr)"></line>
  <text x="363" y="42" text-anchor="middle" class="d-label-muted" font-size="10">replicates</text>
  <text x="125" y="154" text-anchor="end" class="d-label" font-size="11">Active-Active</text>
  <rect x="140" y="130" width="150" height="40" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="215" y="155" text-anchor="middle" class="d-actor-label" font-size="12">Region A</text>
  <rect x="440" y="130" width="150" height="40" rx="8" class="d-actor-box" data-role="datastore"></rect>
  <text x="515" y="155" text-anchor="middle" class="d-actor-label" font-size="12">Region B</text>
  <line x1="290" y1="142" x2="436" y2="142" class="d-msg d-request" marker-end="url(#arrowDr)"></line>
  <line x1="436" y1="158" x2="290" y2="158" class="d-msg d-request" marker-end="url(#arrowDr)"></line>
  <text x="363" y="178" text-anchor="middle" class="d-label-muted" font-size="10">replicates both ways</text>
  <defs>
    <marker id="arrowDr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Active-passive keeps writes in one place, simple to reason about but with idle standby capacity and a real failover step. Active-active takes writes in both regions at once — no idle capacity, but now two regions can write the same data at nearly the same time.</div>
</div>

**Active-passive** serves all traffic from one region while a second continuously receives a replicated copy but serves nothing, on standby until needed. It's simpler — only one region ever takes writes, so there's no cross-region write conflict to resolve — but the standby region's capacity normally sits idle, and failing over (promoting the passive region to active) takes real time and coordination: the same leader-promotion process from Replication and Distributed Locking & Leader Election, just executed over a much slower, longer link.

**Active-active** has multiple regions accept writes simultaneously, each serving its own nearby users for lower latency — the same distance argument CDNs & Edge Delivery makes for static content, applied to the whole backend. No capacity sits idle, and no single region is a point of failure for writes. The cost: two regions can now write the same piece of data at nearly the same moment, which is exactly the multi-leader replication conflict problem from Replication, at global scale — it needs the same conflict resolution strategies (last-write-wins, CRDTs, an application-level merge), just with a much larger cross-region latency gap making conflicts more likely to actually happen.

## RPO and RTO: naming what "survives" actually means

**Recovery Point Objective (RPO)** is how much data can be lost, measured in time — an RPO of 5 minutes means that, worst case, up to 5 minutes of the most recent writes might not have reached the backup region before a failure, and are gone for good. **Recovery Time Objective (RTO)** is how long the system can be down before service is restored — an RTO of 30 minutes means failover, however it happens, has to complete within that window. These two numbers are the honest way to describe what a disaster recovery plan actually guarantees; "we have disaster recovery" without stated RPO and RTO is really just a hope. Asynchronous replication (Replication) means RPO can never be exactly zero unless writes are replicated synchronously across regions — a latency cost most systems can't afford to pay on every single write.

## Why this matters for system design

Multi-region design forces every trade-off from Replication and Consistency Models & CAP to be answered again, at a scale where the costs — cross-region latency, conflict resolution, idle standby capacity — are larger and harder to hide. It's also usually the last piece of resilience a system adds, and often the most expensive relative to the risk it covers: whether it's worth the cost is a real judgment call about how much a specific business can tolerate an hours-long, region-wide outage, not a default every system needs.

## Real-world examples

- **AWS, GCP, and Azure** all organize infrastructure into geographically separate regions specifically so a system can be architected to survive one of them failing.
- **Netflix's "Chaos Kong"** — a tool built to deliberately simulate an entire AWS region failing, to test whether multi-region failover actually works before a real outage forces the question.
- **DynamoDB Global Tables, Cosmos DB** — managed databases offering built-in active-active multi-region replication.
