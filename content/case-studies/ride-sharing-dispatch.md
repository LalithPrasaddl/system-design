# Ride-Sharing Dispatch

Ride-sharing dispatch takes a rider standing at a kerb and finds the driver who can reach them soonest, in seconds. It isn't just a nearby search. Every driver is moving, and their positions are a few seconds out of date by the time anyone reads them. Two riders can want the same driver at the same moment, and a driver can only take one. And when a stadium empties, demand can outrun the drivers nearby tenfold. This case study builds dispatch for a ride-hailing app in 600 cities: 1.5 million drivers online at peak, each reporting its position every 4 seconds, and 25 million rides a day.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the service that matches ride requests to drivers, prices each ride, and keeps the rider and driver informed until pickup. The running example is Chicago. A rider is at Union Station on a Friday night, and later a hockey game lets out at the United Center, 2.8 km to the west. Finding places that don't move, such as restaurants, is [Proximity Search](#/systems-case-studies/proximity-search). Charging the rider and paying the driver is [Payment Processing](#/systems-case-studies/payment-processing). This design handles everything between "request a ride" and "driver arrived".

### Functional requirements

- **Drivers report their position**: every driver who is online sends their position, heading and speed every 4 seconds.
- **Quote a price**: for a pickup and drop-off, return a fare and a pickup time, and hold that fare for 2 minutes.
- **Match a ride**: find the driver who can reach the pickup soonest, by road, and offer them the ride. If they decline or don't answer, offer it to the next driver.
- **One ride per driver, one driver per ride**: a driver never gets two rides at once, and a rider never gets two drivers.
- **Track the driver**: once a driver accepts, the rider sees the car move towards them.
- **Cancel**: either side can cancel before pickup.
- **Price for demand**: when riders in an area far outnumber free drivers, the price rises there.

### Non-functional requirements

- **Time to match:** a driver has accepted within **10 seconds** for half of rides and within **60 seconds** for 99%, when drivers are available.
- **Dispatch decision:** under **200ms** of server time to choose a driver.
- **Freshness:** a driver's position in the index is never more than **5 seconds** older than the last update their phone sent.
- **Correctness:** never two rides assigned to one driver, and never two drivers to one ride.
- **Availability:** 99.99%. A failure in one city, or one region, doesn't stop rides elsewhere, and a server failure never loses a ride that's in progress.
- **Scale:** **1.5 million** drivers online at peak, **25 million** rides a day.

### In scope

Driver positions, finding candidates, picking a driver by driving time, offers and their timeouts, keeping assignments exclusive, live tracking, batch matching, surge pricing, and dividing the world into markets that run independently.

### Out of scope

**Payments**: the fare is handed to the payments system after the ride. **Routing and maps**: an ETA service that knows the roads and the traffic is assumed. **Shared rides**, where several riders share one car. **Driver sign-up, background checks and ratings**. **Turn-by-turn navigation** inside the driver's app.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The data is tiny. Every online driver's latest position fits in a few dozen megabytes. What shapes the design is how often that data changes, and how much a few contended moments matter.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Drivers online</div>
<div class="stat-tile-value">~1.5<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">at the global peak · 30,000 in Chicago</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Position updates</div>
<div class="stat-tile-value">~375<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">one every 4 s per driver</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Rides</div>
<div class="stat-tile-value">~25<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~900/s at peak</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Price quotes</div>
<div class="stat-tile-value">~4,500<span class="stat-tile-unit">/s</span></div>
<div class="stat-tile-sub">at peak · ~5 per ride taken</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Live positions to riders</div>
<div class="stat-tile-value">~250<span class="stat-tile-unit">K/s</span></div>
<div class="stat-tile-sub">~1M rides in progress at once</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Latest positions</div>
<div class="stat-tile-value">~50<span class="stat-tile-unit">MB</span></div>
<div class="stat-tile-sub">32 bytes per online driver</div>
</div>
</div>

### Assumptions

- At the global peak, **1.5 million** drivers are online, about 800,000 on average. Chicago peaks at **30,000** on a Friday night.
- Each phone sends its position every **4 seconds** while the driver is online.
- **25 million** rides a day. Peaks are about **3 times** the average.
- A rider asks for about **5 quotes** for every ride they take: they check the price, change the destination, or wait for it to drop.
- A ride lasts about **20 minutes** from acceptance to drop-off, including the drive to the pickup.

### Position updates

1.5 million drivers each sending every 4 seconds is **375,000 updates a second** at peak. On average it's 200,000 a second, about 17 billion a day. Each update is about 60 bytes, so the raw stream is around **1TB a day**. Most of that is only needed for a few seconds, until the next update replaces it. The routes of rides in progress are kept, for fares and disputes.

### Rides and quotes

25 million rides a day is 290 a second on average and **about 900 a second** at peak. Quotes are five times that, about 4,500 a second. Each match asks the ETA service for the driving time of up to 10 candidates, about 9,000 ETA lookups a second at peak.

### Live tracking

900 rides a second, each lasting about 20 minutes, means about a million in progress at the peak. Each rider gets their driver's position every 4 seconds: **about 250,000 pushes a second**.

### Contention

Contention is local. A stadium emptying sends 3,000 requests in 15 minutes from one square kilometre, where perhaps 60 drivers are free. That's a tiny load in requests per second, but nearly every request wants one of the same few drivers.

<!-- tab:api-design:API Design -->

## API Design

Drivers and riders both keep a connection open to the service. Positions, offers and live tracking move over it as messages. Actions that change a ride are ordinary requests, so they can be retried safely.

### Driver position and status

```
POST /v1/drivers/me/status
{"status": "online"}
→ 200 {"status": "online"}

over the driver's connection, every 4 s:
{"type": "location", "lat": 41.8826, "lng": -87.6478,
 "heading": 180, "speed_kmh": 28, "ts": "2026-10-16T23:02:11.240Z", "seq": 9120}
```

### Quote and request

```
POST /v1/quotes
{"pickup": {"lat": 41.8789, "lng": -87.6403}, "dropoff": {"lat": 41.9484, "lng": -87.6553},
 "product": "standard"}
→ 200 {"quote_id": "q_8812", "fare": "18.40", "currency": "USD", "surge": 1.0,
       "pickup_eta_s": 240, "expires_at": "2026-10-16T23:04:30Z"}

POST /v1/rides
{"quote_id": "q_8812", "client_request_id": "c1b7e2"}
→ 202 {"ride_id": "rd_40917", "status": "matching"}
```

### Offers to drivers

```
over the driver's connection:
{"type": "offer", "offer_id": "of_771", "ride_id": "rd_40917",
 "pickup": {"lat": 41.8789, "lng": -87.6403}, "pickup_eta_s": 240,
 "fare": "18.40", "expires_in_s": 15}

POST /v1/offers/of_771/accept
→ 200 {"ride_id": "rd_40917", "rider": {"first_name": "…", "pickup_note": "…"}}
→ 409 {"error": "offer_no_longer_valid", "reason": "expired"}

POST /v1/offers/of_771/decline
→ 200
```

### Following and cancelling a ride

```
over the rider's connection:
{"type": "matched", "ride_id": "rd_40917", "driver": {…}, "pickup_eta_s": 240}
{"type": "driver_location", "lat": 41.8812, "lng": -87.6441, "heading": 160, "ts": "…"}

POST /v1/rides/rd_40917/cancel
→ 200 {"status": "cancelled", "fee": "0.00"}

POST /v1/rides/rd_40917/arrived   (driver)
POST /v1/rides/rd_40917/start     (driver)
POST /v1/rides/rd_40917/complete  (driver)
```

| Code | Meaning |
|---|---|
| `200` | Done |
| `202` | Ride created, matching has started |
| `400` | Position out of range, or pickup outside every market |
| `404` | No such ride, quote or offer |
| `409` | The ride or offer has moved on: the offer expired or was withdrawn, the ride was already matched or cancelled |
| `410` | The quote has expired; ask for a new one |
| `429` | Over the caller's request rate |

### Why the details matter

**Positions travel as messages, not requests.** 375,000 a second, each replacing the last. A lost one doesn't need to be retried, because the next one arrives 4 seconds later. A request and response for each would double the traffic for nothing.

**Each position carries the phone's own time and a sequence number.** Updates can arrive out of order after a phone switches networks. The service keeps the newest by sequence and ignores any that are older.

**A request names a quote.** The price the rider saw is the price they pay, even if surge changes a second later. A quote expires after 2 minutes, so a price can't be held from before a rush and used during it.

**A request carries a client request ID.** A rider who taps again because the screen froze gets the same ride, not a second one ([Idempotency](#/systems/idempotency)).

**Offers expire and accepts can fail.** The driver has 15 seconds. An accept that arrives after that, or after the rider cancelled, gets `409`, and the driver's app says the ride is gone.

**`202`, not `201`.** The ride exists, but matching takes seconds. The result arrives over the rider's connection.

<!-- tab:data-model:Data Model -->

## Data Model

Rides are the permanent record, kept in a relational database. Who each driver is busy with is kept in a store that allows conditional writes, because every assignment is a race. Positions are kept only in memory, because they're replaced every 4 seconds.

### Rides and quotes

```
rides                                    -- relational DB, per market
  ride_id            TEXT PRIMARY KEY    -- rd_40917
  rider_id           TEXT
  client_request_id  TEXT                -- UNIQUE (rider_id, client_request_id)
  quote_id           TEXT
  market             TEXT                -- chicago
  pickup_lat, pickup_lng      DOUBLE
  dropoff_lat, dropoff_lng    DOUBLE
  status             TEXT                -- matching | driver_assigned | arriving | in_trip
                                         -- | completed | cancelled | no_driver
  driver_id          TEXT
  fare               NUMERIC
  surge              NUMERIC
  requested_at, matched_at, picked_up_at, completed_at  TIMESTAMP
  version            INT

quotes
  quote_id     TEXT PRIMARY KEY          -- q_8812
  rider_id     TEXT
  pickup_cell  TEXT                      -- dp3wjx
  fare         NUMERIC
  surge        NUMERIC
  expires_at   TIMESTAMP                 -- 2 minutes after it was given
```

### Driver state (from Stage 3)

```
driver_state                             -- replicated key-value store, conditional writes
  driver_id      d_3381
  status         offline | available | offered | en_route | on_trip
  offer_id       of_771                  -- while offered
  offer_expires  23:04:15                -- while offered
  ride_id        rd_40917                -- while en_route or on_trip
  next_ride_id   rd_41220                -- a ride queued for after this one (from Stage 4)
  market         chicago
  version        813

offers
  offer_id   of_771
  ride_id    rd_40917
  driver_id  d_3381
  sent_at, expires_at
  outcome    accepted | declined | expired | withdrawn
```

### The location index (from Stage 2)

```
in memory in the location service, per market
  drivers   driver_id → lat, lng, heading, speed, status, last_seen, seq   -- 32 bytes
  cells     geohash6 → set of driver_ids                                  -- dp3wjx → {d_3381, …}

location stream                           -- append-only log
  driver_id, ts, lat, lng, heading, speed, ride_id (if any)
  → trip recorder keeps the route of each ride, for fares and disputes
```

### Surge (from Stage 4)

```
surge          per market, in memory, recomputed every minute
  cell (geohash6) → demand, supply, multiplier
  dp3wkb → 900 quotes/min, 60 drivers, 2.1×
```

### Why this storage

A ride is created once, changes state a handful of times, and must never be lost: a relational table, with its status changed only by conditional updates, partitioned by market ([Databases: Relational](#/systems/databases-relational)). A driver's state changes with every offer, often several times a minute, and two dispatchers may try to change it at once. So it lives in a store that applies writes to one key in order and refuses a write whose condition no longer holds, replicated across three zones so that it survives a lost server ([Replication](#/systems/replication), [Consistency & CAP](#/systems/consistency-cap)). Positions are the opposite: worthless 4 seconds later, needed tens of thousands of times a second. They're kept only in memory, and the stream keeps the history that matters ([Batch vs Stream Processing](#/systems/batch-vs-stream)).

<!-- tab:architecture:Architecture:default -->

This case study builds ride-sharing dispatch up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. One Table of Drivers -->

## Stage 1 — A Table of Drivers and Their Positions

The simplest dispatch keeps every driver in a table, with a position and a status. Drivers' apps post their position every 4 seconds, and each post updates the driver's row. When a rider asks for a ride, the app server finds the nearest available driver in a box around the pickup, marks them assigned, and creates the ride. The driver finds out in the response to their next position post.

```
SELECT driver_id, lat, lng FROM drivers
WHERE status = 'available'
  AND lat BETWEEN 41.8699 AND 41.8879
  AND lng BETWEEN -87.6524 AND -87.6282
ORDER BY (lat - 41.8789)^2 + ((lng + 87.6403) * 0.744)^2
LIMIT 1
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 300" width="780" height="300" role="img" aria-label="Driver apps post their positions to an app server, which updates each driver's row in a database; a rider's request makes the app server find the nearest available driver in the database and assign them">
  <rect x="20" y="40" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Driver App</text>
  <text x="90" y="83" text-anchor="middle" class="d-label-muted" font-size="9">posts its position every 4 s</text>
  <rect x="20" y="190" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="216" text-anchor="middle" class="d-actor-label" font-size="12">Rider App</text>
  <text x="90" y="233" text-anchor="middle" class="d-label-muted" font-size="9">requests a ride</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="110" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="130" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="148" text-anchor="middle" class="d-label-muted" font-size="9">saves positions</text>
    <text x="350" y="163" text-anchor="middle" class="d-label-muted" font-size="9">nearest driver → assign</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="560" y="100" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="131" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="149" text-anchor="middle" class="d-label-muted" font-size="9">drivers · position + status</text>
    <text x="660" y="164" text-anchor="middle" class="d-label-muted" font-size="9">rides</text>
  </g>
  <line id="r1-d-app" x1="162" y1="62" x2="256" y2="118" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowR1)"></line>
  <line id="r1-app-d" x1="256" y1="140" x2="162" y2="86" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowR1r)"></line>
  <line id="r1-r-app" x1="162" y1="212" x2="256" y2="168" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowR1)"></line>
  <line id="r1-app-r" x1="256" y1="190" x2="162" y2="236" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowR1r)"></line>
  <line id="r1-app-db" x1="442" y1="136" x2="556" y2="136" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowR1)"></line>
  <line id="r1-db-app" x1="556" y1="166" x2="442" y2="166" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowR1r)"></line>
  <text x="390" y="290" text-anchor="middle" class="d-label-muted" font-size="10">play a ride from Union Station, then Friday night with 30,000 drivers, then the driver on the expressway</text>
  <defs>
    <marker id="arrowR1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "ride", "title": "This ride", "rows": [["rider", "—"], ["driver", "—"], ["pickup in", "—"]]},
{"id": "db", "title": "Database", "rows": [["position writes", "—"], ["positions are", "—"]]}
],
"flows": [
{
"id": "union",
"label": "A ride from Union Station",
"nodes": ["app1", "db1"],
"steps": [
{"el": "r1-r-app", "payload": "POST /rides · pickup 41.8789, -87.6403", "set": {"ride.rider": "r_5120 · Union Station", "ride.driver": "—", "ride.pickup in": "—", "db.position writes": "100/s", "db.positions are": "≤ 4 s old"}, "text": "The app has just launched in Chicago, with 400 drivers online. A rider, r_5120, at Union Station asks for a ride north to Lakeview."},
{"el": "r1-app-db", "payload": "nearest available driver within 1 km", "text": "The app server asks the database for the nearest available driver in a box about 1 km in each direction around the pickup. At Chicago's latitude, a degree of longitude is 0.744 times as long as a degree of latitude, so the distance formula scales it."},
{"el": "r1-db-app", "payload": "d_3381 · 1.1 km", "ms": 20, "set": {"ride.driver": "d_3381 · 1.1 km away"}, "text": "With a few hundred drivers in the table, the query is quick. The nearest available driver is d_3381, 1.1 km north."},
{"el": "r1-app-db", "payload": "UPDATE drivers SET status='assigned' · INSERT ride rd_40917", "ms": 5, "text": "The app server marks the driver assigned and creates the ride."},
{"el": "r1-d-app", "payload": "POST /location · 41.8890, -87.6440", "text": "The driver's app posts its position, as it does every 4 seconds."},
{"el": "r1-app-d", "payload": "you have a ride: rd_40917 · Union Station", "text": "The ride comes back in the response. The driver can learn about it up to 4 seconds late, because the server has no way to reach the phone until the phone next asks."},
{"el": "r1-app-r", "payload": "driver d_3381 · about 4 min", "set": {"ride.pickup in": "~4 min"}, "text": "The rider is told who's coming. For one city at launch, this works."}
]
},
{
"id": "friday",
"label": "Friday night, 30,000 drivers",
"nodes": ["app1", "db1"],
"steps": [
{"el": "r1-d-app", "payload": "30,000 drivers × every 4 s", "set": {"ride.rider": "—", "ride.driver": "—", "ride.pickup in": "—", "db.position writes": "7,500/s", "db.positions are": "≤ 4 s old"}, "text": "A year later, at 23:00 on a Friday, 30,000 drivers are online in Chicago. That's 7,500 position posts a second."},
{"el": "r1-app-db", "payload": "7,500 UPDATE drivers/s", "text": "Each post is a database write. It rewrites the driver's row, moves its entries in the latitude and longitude indexes, is logged to disk and copied to a replica, and leaves an old row version behind to be cleaned up. A position that will be replaced in 4 seconds is stored as carefully as a payment."},
{"el": "r1-db-app", "payload": "writes queue · 3 s each", "ms": 3000, "set": {"db.position writes": "7,500/s · queueing", "db.positions are": "~20 s old"}, "text": "The database falls behind. Writes wait in line, and the positions it holds are about 20 seconds old by the time they're saved. A car at 40 km/h covers 220 metres in that time."},
{"el": "r1-r-app", "payload": "POST /rides · Union Station", "set": {"ride.rider": "r_5120 · Union Station"}, "text": "A rider at Union Station asks for a ride."},
{"el": "r1-app-db", "payload": "nearest available driver", "text": "The app server runs the same query, in the same queue as the writes."},
{"el": "r1-db-app", "payload": "d_1170 · 300 m — as of 20 s ago", "ms": 2500, "set": {"ride.driver": "d_1170 · where they were 20 s ago"}, "text": "It takes 2.5 seconds, and the answer is a driver who was 300 metres away 20 seconds ago and has since driven on."},
{"el": "r1-app-r", "payload": "matched, slowly, to the wrong car", "set": {"ride.pickup in": "~7 min"}, "text": "The bottleneck isn't the number of drivers, which is small. It's that every 4-second position is treated as a permanent record."}
]
},
{
"id": "expressway",
"label": "The driver on the expressway",
"nodes": ["app1", "db1"],
"steps": [
{"el": "r1-r-app", "payload": "POST /rides · Union Station", "set": {"ride.rider": "r_5120 · Union Station", "ride.driver": "—", "ride.pickup in": "—", "db.position writes": "100/s", "db.positions are": "≤ 4 s old"}, "text": "On a quiet evening, the rider at Union Station asks again."},
{"el": "r1-app-db", "payload": "ORDER BY straight-line distance", "text": "The query picks the nearest driver as the crow flies."},
{"el": "r1-db-app", "payload": "d_2290 · 300 m", "ms": 20, "set": {"ride.driver": "d_2290 · 300 m"}, "text": "The nearest is d_2290, 300 metres west. But d_2290 is on the expressway, heading north at 80 km/h. To reach Union Station they have to leave at the next exit, turn around and come back."},
{"el": "r1-app-d", "payload": "you have a ride: Union Station", "text": "The ride goes to d_2290."},
{"el": "r1-app-r", "payload": "driver d_2290 · 9 min", "set": {"ride.pickup in": "9 min · 4 min was possible"}, "text": "9 minutes. Meanwhile d_3381, 1.1 km north on surface streets, could have been there in 4. Distance is the wrong measure: what matters is driving time, which depends on roads, direction and traffic."}
]
}
]
}
</script>
<div class="diagram-caption">The app server saves every driver's position in a database row and, for each ride request, asks the same database for the nearest available driver. The driver learns about the ride in the response to their next position post.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> no positions are saved and no rides are matched. Drivers already on their way keep going, but nobody can tell them a rider cancelled.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> everything stops. Positions, matching and every ride's state all live in it.
</div>
</div>

A driver's position is useful for 4 seconds and then replaced, yet each one costs a durable database write. And the nearest driver in a straight line can be the wrong driver by five minutes. Positions should live somewhere cheap to overwrite, and the choice of driver should be made by driving time.

<!-- stage:2:2. Positions in Memory -->

## Stage 2 — Keep Positions in Memory, Choose by Driving Time

- **Drivers keep a connection open.** Each driver's app holds a connection to a gateway server and sends its position over it every 4 seconds. The same connection carries offers to the driver the moment they're made ([Real-time Delivery](#/systems/realtime-delivery)).
- **A location service holds the latest position of every driver, in memory.** An update overwrites one 32-byte entry. Nothing is written to disk on this path.
- **Drivers are grouped into fixed cells.** Each cell is a 6-character geohash, about 610 by 910 metres in Chicago. Union Station is in `dp3wjx`. The location service keeps, for each cell, the set of drivers in it. A car at city speed moves about 33 metres in 4 seconds, so about 91% of updates stay in the same cell and change nothing but the entry. The rest move the driver from one cell's set to another's.
- **Silent drivers disappear.** A driver who hasn't sent anything for 20 seconds, in a tunnel or with a dead phone, is removed from their cell until they're heard from again.
- **The stream keeps the history.** Every update is also appended to a location stream. A trip recorder reads it and keeps the route of each ride in progress, which is what the fare and any dispute are based on. The positions in memory can be lost; within 4 seconds, every driver has sent a new one.
- **Dispatch chooses by driving time.** It asks the location service for available drivers in the pickup's cell, then the ring of 8 cells around it, then the next ring, until it has 10 or reaches 5 km. It asks an ETA service, which knows the roads, one-way streets and live traffic, for each candidate's driving time to the pickup, and picks the shortest.
- **Riders watch the car.** Once a driver accepts, the location service forwards that driver's updates to the rider's connection.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 390" width="860" height="390" role="img" aria-label="Driver and rider apps connect to a gateway; driver positions go to a location service holding positions in memory by cell, and onto a location stream; ride requests go to dispatch, which gets candidates from the location service, driving times from an ETA service, and records the ride in a rides database">
  <rect x="20" y="40" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Driver App</text>
  <text x="80" y="83" text-anchor="middle" class="d-label-muted" font-size="9">position every 4 s</text>
  <rect x="20" y="270" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Rider App</text>
  <text x="80" y="313" text-anchor="middle" class="d-label-muted" font-size="9">requests, watches car</text>
  <g data-fail-toggle="gw2">
    <rect x="190" y="140" width="140" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="260" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Gateway</text>
    <text x="260" y="198" text-anchor="middle" class="d-label-muted" font-size="9">holds open connections</text>
  </g>
  <g data-fail-toggle="loc2">
    <rect x="400" y="30" width="190" height="90" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="495" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Location Service</text>
    <text x="495" y="80" text-anchor="middle" class="d-label-muted" font-size="9">latest position per driver</text>
    <text x="495" y="95" text-anchor="middle" class="d-label-muted" font-size="9">in memory, by geohash6 cell</text>
  </g>
  <g data-fail-toggle="str2">
    <rect x="660" y="30" width="180" height="90" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="750" y="62" text-anchor="middle" class="d-actor-label" font-size="12">Location Stream</text>
    <text x="750" y="80" text-anchor="middle" class="d-label-muted" font-size="9">every update, in order</text>
    <text x="750" y="95" text-anchor="middle" class="d-label-muted" font-size="9">→ trip routes</text>
  </g>
  <g data-fail-toggle="dis2">
    <rect x="400" y="160" width="190" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="495" y="192" text-anchor="middle" class="d-actor-label" font-size="12">Dispatch</text>
    <text x="495" y="210" text-anchor="middle" class="d-label-muted" font-size="9">10 candidates → fastest by road</text>
  </g>
  <g data-fail-toggle="eta2">
    <rect x="660" y="160" width="180" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="750" y="192" text-anchor="middle" class="d-actor-label" font-size="12">ETA Service</text>
    <text x="750" y="210" text-anchor="middle" class="d-label-muted" font-size="9">roads + live traffic</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="400" y="290" width="190" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="495" y="316" text-anchor="middle" class="d-actor-label" font-size="12">Rides DB</text>
    <text x="495" y="333" text-anchor="middle" class="d-label-muted" font-size="9">rides + driver status</text>
  </g>
  <line id="s2-d-gw" x1="142" y1="62" x2="226" y2="136" class="d-msg d-request" data-depends-on="gw2" marker-end="url(#arrowR2)"></line>
  <line id="s2-gw-d" x1="246" y1="136" x2="142" y2="90" class="d-msg d-response" data-depends-on="gw2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-r-gw" x1="142" y1="290" x2="226" y2="244" class="d-msg d-request" data-depends-on="gw2" marker-end="url(#arrowR2)"></line>
  <line id="s2-gw-r" x1="246" y1="244" x2="142" y2="316" class="d-msg d-response" data-depends-on="gw2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-gw-loc" x1="300" y1="138" x2="396" y2="80" class="d-msg d-request" data-depends-on="gw2 loc2" marker-end="url(#arrowR2)"></line>
  <line id="s2-loc-gw" x1="396" y1="104" x2="322" y2="138" class="d-msg d-response" data-depends-on="gw2 loc2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-gw-dis" x1="332" y1="186" x2="396" y2="186" class="d-msg d-request" data-depends-on="gw2 dis2" marker-end="url(#arrowR2)"></line>
  <line id="s2-dis-gw" x1="396" y1="220" x2="332" y2="220" class="d-msg d-response" data-depends-on="gw2 dis2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-dis-loc" x1="470" y1="156" x2="470" y2="124" class="d-msg d-request" data-depends-on="dis2 loc2" marker-end="url(#arrowR2)"></line>
  <line id="s2-loc-dis" x1="520" y1="124" x2="520" y2="156" class="d-msg d-response" data-depends-on="dis2 loc2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-dis-eta" x1="592" y1="190" x2="656" y2="190" class="d-msg d-request" data-depends-on="dis2 eta2" marker-end="url(#arrowR2)"></line>
  <line id="s2-eta-dis" x1="656" y1="220" x2="592" y2="220" class="d-msg d-response" data-depends-on="dis2 eta2" marker-end="url(#arrowR2r)"></line>
  <line id="s2-dis-db" x1="480" y1="252" x2="480" y2="286" class="d-msg d-request" data-depends-on="dis2 db2" marker-end="url(#arrowR2)"></line>
  <line id="s2-loc-str" x1="592" y1="75" x2="656" y2="75" class="d-msg d-request" data-depends-on="loc2 str2" marker-end="url(#arrowR2)"></line>
  <text x="430" y="380" text-anchor="middle" class="d-label-muted" font-size="10">play Friday night with 30,000 drivers, then a ride from Union Station, then two riders and one driver</text>
  <defs>
    <marker id="arrowR2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "loc", "title": "Location service", "rows": [["updates", "—"], ["cell dp3wjx", "—"], ["d_3381", "—"]]},
{"id": "ride", "title": "This ride", "rows": [["candidates", "—"], ["chosen", "—"], ["pickup in", "—"]]}
],
"flows": [
{
"id": "friday",
"label": "Friday night, 30,000 drivers",
"nodes": ["gw2", "loc2", "str2"],
"steps": [
{"el": "s2-d-gw", "payload": "location · 41.8890, -87.6440 · seq 9120", "set": {"loc.updates": "7,500/s", "loc.cell dp3wjx": "41 drivers", "loc.d_3381": "41.8890, -87.6440 · 0 s ago", "ride.candidates": "—", "ride.chosen": "—", "ride.pickup in": "—"}, "text": "Friday, 23:00. 30,000 drivers are online and each sends a position every 4 seconds over their open connection: 7,500 a second."},
{"el": "s2-gw-loc", "payload": "7,500 updates/s", "ms": 1, "text": "The gateway passes each update to the location service, which overwrites the driver's entry in memory: position, heading, speed, time and sequence number. For 91% of updates the driver is still in the same cell and that's all. For the rest, the driver is moved from one cell's set to its neighbour's. Each update takes microseconds; 7,500 a second is a few percent of one server."},
{"el": "s2-loc-str", "payload": "append to the location stream", "text": "Each update is also appended to the location stream. The trip recorder keeps the route of every ride in progress from it. The positions in memory are disposable: if the service restarts, every driver has sent a fresh one within 4 seconds."},
{"el": "s2-d-gw", "payload": "d_8812 · last update 20 s ago", "text": "Driver d_8812 drives into the tunnels under Wacker Drive and the phone loses signal."},
{"el": "s2-gw-loc", "payload": "d_8812 · silent 20 s → removed from its cell", "set": {"loc.cell dp3wjx": "40 drivers"}, "text": "After 20 seconds without an update, the location service takes d_8812 out of its cell. Nobody is offered a driver whose position is a guess. When the phone reconnects, its next update puts them back."}
]
},
{
"id": "union",
"label": "A ride from Union Station",
"nodes": ["gw2", "dis2", "loc2", "eta2", "db2"],
"steps": [
{"el": "s2-r-gw", "payload": "POST /rides · pickup 41.8789, -87.6403", "set": {"loc.updates": "7,500/s", "loc.cell dp3wjx": "40 drivers · 6 available", "loc.d_3381": "41.8890, -87.6440 · available", "ride.candidates": "—", "ride.chosen": "—", "ride.pickup in": "—"}, "text": "The rider at Union Station asks for a ride."},
{"el": "s2-gw-dis", "payload": "match rd_40917 · 41.8789, -87.6403", "text": "The gateway passes the request to a dispatch server."},
{"el": "s2-dis-loc", "payload": "available drivers near dp3wjx", "text": "Dispatch asks the location service for available drivers around the pickup's cell, dp3wjx, 610 by 910 metres. The service reads that cell's set, then the ring of 8 cells around it, and stops when it has 10."},
{"el": "s2-loc-dis", "payload": "10 candidates · 300 m – 1.6 km", "ms": 1, "set": {"ride.candidates": "10 · from 9 cells"}, "text": "Ten available drivers, from 300 metres to 1.6 km away, with positions at most 4 seconds old."},
{"el": "s2-dis-eta", "payload": "driving time: 10 drivers → Union Station", "text": "Dispatch asks the ETA service how long each would take to drive to the pickup, given which way they're heading."},
{"el": "s2-eta-dis", "payload": "d_3381: 4 min · … · d_2290: 9 min", "ms": 30, "set": {"ride.chosen": "d_3381 · 1.1 km · 4 min"}, "text": "d_2290, 300 metres away on the expressway heading north, is 9 minutes. d_3381, 1.1 km north on surface streets, is 4. Dispatch picks d_3381."},
{"el": "s2-dis-db", "payload": "rd_40917 → d_3381 · driver status: assigned", "ms": 5, "text": "Dispatch records the ride and marks the driver assigned."},
{"el": "s2-dis-gw", "payload": "offer → d_3381", "text": "The offer goes straight down the driver's open connection, with no waiting for their next post."},
{"el": "s2-gw-d", "payload": "offer rd_40917 · Union Station · 4 min", "text": "d_3381's phone shows the ride a few milliseconds after dispatch chose it."},
{"el": "s2-d-gw", "payload": "accept", "text": "The driver accepts."},
{"el": "s2-loc-gw", "payload": "d_3381's position every 4 s → r_5120", "text": "From now on, the location service forwards every update from d_3381 to r_5120's connection as well."},
{"el": "s2-gw-r", "payload": "driver 4 min away · car on the map", "set": {"ride.pickup in": "4 min"}, "text": "The rider watches the car come down Clinton Street. The phone animates it between updates using its heading and speed."}
]
},
{
"id": "race",
"label": "Two riders, one driver",
"nodes": ["gw2", "dis2", "loc2", "eta2", "db2"],
"steps": [
{"el": "s2-r-gw", "payload": "r_5120 and r_6604 · 120 m apart · same second", "set": {"loc.updates": "7,500/s", "loc.cell dp3wjx": "40 drivers", "loc.d_3381": "available", "ride.candidates": "—", "ride.chosen": "—", "ride.pickup in": "—"}, "text": "Two riders, 120 metres apart outside Union Station, ask for a ride in the same second."},
{"el": "s2-gw-dis", "payload": "two requests → two dispatch servers", "text": "The gateway sends each to a different dispatch server."},
{"el": "s2-dis-loc", "payload": "available near dp3wjx · ×2", "text": "Both ask the location service for available drivers."},
{"el": "s2-loc-dis", "payload": "both: d_3381 available", "ms": 1, "set": {"ride.candidates": "10 each · same 10"}, "text": "Both get the same ten, including d_3381."},
{"el": "s2-dis-eta", "payload": "driving times · ×2", "text": "Both ask for driving times."},
{"el": "s2-eta-dis", "payload": "both: d_3381 · 4 min", "ms": 30, "set": {"ride.chosen": "d_3381 · for both"}, "text": "The riders are close together, so the same driver is fastest for both."},
{"el": "s2-dis-db", "payload": "rd_40917 → d_3381 · rd_40922 → d_3381", "ms": 5, "text": "Each dispatch server records its ride with d_3381 as the driver and marks d_3381 assigned. Neither checked whether the driver was still available when it wrote: it had read that a moment earlier, from the location service's copy."},
{"el": "s2-gw-d", "payload": "two offers for d_3381", "text": "d_3381's phone shows two offers. The driver accepts the first."},
{"el": "s2-gw-r", "payload": "r_6604: driver on the way · never arrives", "set": {"ride.pickup in": "r_6604: never"}, "text": "r_6604 is told d_3381 is coming, and waits for a car that has gone to someone else. And if a driver ignores an offer, nothing withdraws it: the rider waits until they give up."}
]
}
]
}
</script>
<div class="diagram-caption">Drivers keep a connection to a gateway and send their positions over it. A location service holds the latest position of every driver in memory, grouped by fixed cells, and writes each update to a stream. Dispatch takes the nearest available drivers from the location service and picks the one with the shortest driving time.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw2">
<strong>If a gateway server fails:</strong> the phones connected to it reconnect to another within a few seconds. Their positions pause for that long, and offers sent in that moment are lost.
</div>
<div class="failure-impact is-hidden" data-component="loc2">
<strong>If the location service fails:</strong> every position is gone. A replacement starts empty and fills up from the updates arriving: within 4 seconds most drivers are back, within 8 nearly all. Dispatch waits for that.
</div>
<div class="failure-impact is-hidden" data-component="str2">
<strong>If the location stream fails:</strong> matching keeps working from memory. Routes of rides in progress have a gap; those fares are worked out from the pickup and drop-off by road instead.
</div>
<div class="failure-impact is-hidden" data-component="dis2">
<strong>If a dispatch server fails:</strong> the gateway sends new requests to another. Rides it was in the middle of matching sit in the database as matching, with nobody working on them.
</div>
<div class="failure-impact is-hidden" data-component="eta2">
<strong>If the ETA service fails:</strong> dispatch picks by straight-line distance, multiplied by a road factor for the city, and gets it wrong more often until it's back.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the rides database fails:</strong> no new rides can be recorded. Rides in progress continue on the phones and report their completion when it's back.
</div>
</div>

Positions are now cheap and drivers are chosen by driving time. But the decision isn't safe. Dispatch reads that a driver is available from one place and writes that they're assigned somewhere else, and nothing stops another dispatch server doing the same in between. An offer has no time limit, and nothing checks whether an accept refers to an offer that's still open. A driver must be claimed for one ride before they're offered it, and every offer must expire.

<!-- stage:3:3. One Offer per Driver -->

## Stage 3 — Claim the Driver, Then Offer

- **Every driver has one state, in one store.** A replicated key-value store holds each driver's state: `available`, `offered`, `en_route`, `on_trip`. It applies writes to one driver in order, and every write is conditional: it says what the state must be now, and fails if it's anything else ([Distributed Locking](#/systems/distributed-locking)).
- **Dispatch claims before it offers.** "Set d_3381 to `offered(of_771)`, expiring in 15 seconds, if it is `available`." If the condition fails, another dispatcher got there first, and dispatch moves to its next candidate. Only a successful claim sends an offer.
- **The location service keeps a copy of each driver's status**, updated from the store's change feed, to filter candidates. The copy can be a moment out of date. That only causes a failed claim, never a double assignment.
- **Offers expire.** Dispatch keeps a timer for each offer. When it fires, it sets the driver back to `available` if they're still `offered` with that offer, and offers the ride to the next candidate. A sweeper does the same for any offer past its expiry, in case the dispatch server that made it has died. A driver who lets three offers in a row expire is set offline.
- **Accepting is conditional too.** The ride changes from `matching` to `driver_assigned` only if it's still matching; then the driver changes from `offered(of_771)` to `en_route`. A late accept, or one for a ride the rider cancelled, fails and gets `409`.
- **The ride row decides between the rider and the driver.** A cancel and an accept both change the ride's status first, conditionally. Whichever arrives first wins, and the other is undone.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 390" width="860" height="390" role="img" aria-label="Driver and rider apps connect to a gateway; dispatch takes candidates from the location service, claims a driver in the driver state store with a conditional write before sending the offer, and records the ride in the rides database; the driver state store's changes update the location service's copy of each driver's status">
  <rect x="20" y="40" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Driver App</text>
  <text x="80" y="83" text-anchor="middle" class="d-label-muted" font-size="9">offers · 15 s to accept</text>
  <rect x="20" y="270" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Rider App</text>
  <text x="80" y="313" text-anchor="middle" class="d-label-muted" font-size="9">requests, cancels</text>
  <g data-fail-toggle="gw3">
    <rect x="190" y="140" width="140" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="260" y="180" text-anchor="middle" class="d-actor-label" font-size="12">Gateway</text>
    <text x="260" y="198" text-anchor="middle" class="d-label-muted" font-size="9">holds open connections</text>
  </g>
  <g data-fail-toggle="loc3">
    <rect x="400" y="20" width="190" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="495" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Location Service</text>
    <text x="495" y="70" text-anchor="middle" class="d-label-muted" font-size="9">positions + a copy of status</text>
  </g>
  <g data-fail-toggle="dis3">
    <rect x="400" y="140" width="190" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="495" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Dispatch</text>
    <text x="495" y="190" text-anchor="middle" class="d-label-muted" font-size="9">claim, then offer</text>
    <text x="495" y="205" text-anchor="middle" class="d-label-muted" font-size="9">15 s timer per offer</text>
  </g>
  <g data-fail-toggle="ds3">
    <rect x="660" y="140" width="180" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="750" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Driver State</text>
    <text x="750" y="190" text-anchor="middle" class="d-label-muted" font-size="9">available → offered → en route</text>
    <text x="750" y="205" text-anchor="middle" class="d-label-muted" font-size="9">conditional writes · 3 zones</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="660" y="285" width="180" height="65" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="750" y="312" text-anchor="middle" class="d-actor-label" font-size="12">Rides DB</text>
    <text x="750" y="329" text-anchor="middle" class="d-label-muted" font-size="9">status changed conditionally</text>
  </g>
  <line id="t3-d-gw" x1="142" y1="62" x2="226" y2="136" class="d-msg d-request" data-depends-on="gw3" marker-end="url(#arrowR3)"></line>
  <line id="t3-gw-d" x1="246" y1="136" x2="142" y2="90" class="d-msg d-response" data-depends-on="gw3" marker-end="url(#arrowR3r)"></line>
  <line id="t3-r-gw" x1="142" y1="290" x2="226" y2="244" class="d-msg d-request" data-depends-on="gw3" marker-end="url(#arrowR3)"></line>
  <line id="t3-gw-r" x1="246" y1="244" x2="142" y2="316" class="d-msg d-response" data-depends-on="gw3" marker-end="url(#arrowR3r)"></line>
  <line id="t3-gw-dis" x1="332" y1="175" x2="396" y2="175" class="d-msg d-request" data-depends-on="gw3 dis3" marker-end="url(#arrowR3)"></line>
  <line id="t3-dis-gw" x1="396" y1="210" x2="332" y2="210" class="d-msg d-response" data-depends-on="gw3 dis3" marker-end="url(#arrowR3r)"></line>
  <line id="t3-dis-loc" x1="470" y1="136" x2="470" y2="104" class="d-msg d-request" data-depends-on="dis3 loc3" marker-end="url(#arrowR3)"></line>
  <line id="t3-loc-dis" x1="520" y1="104" x2="520" y2="136" class="d-msg d-response" data-depends-on="dis3 loc3" marker-end="url(#arrowR3r)"></line>
  <line id="t3-dis-ds" x1="592" y1="175" x2="656" y2="175" class="d-msg d-request" data-depends-on="dis3 ds3" marker-end="url(#arrowR3)"></line>
  <line id="t3-ds-dis" x1="656" y1="210" x2="592" y2="210" class="d-msg d-response" data-depends-on="dis3 ds3" marker-end="url(#arrowR3r)"></line>
  <path id="t3-dis-db" d="M480,242 L480,305 L656,305" class="d-msg d-request" data-depends-on="dis3 db3" marker-end="url(#arrowR3)"></path>
  <path id="t3-db-dis" d="M656,332 L510,332 L510,244" class="d-msg d-response" data-depends-on="dis3 db3" marker-end="url(#arrowR3r)"></path>
  <path id="t3-ds-loc" d="M750,136 L750,60 L594,60" class="d-msg d-request" data-depends-on="ds3 loc3" marker-end="url(#arrowR3)"></path>
  <text x="430" y="380" text-anchor="middle" class="d-label-muted" font-size="10">play two riders and one driver, then a driver who doesn't answer, then an accept and a cancel that cross</text>
  <defs>
    <marker id="arrowR3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "drv", "title": "Driver state", "rows": [["driver", "—"], ["status", "—"], ["version", "—"]]},
{"id": "rides", "title": "Rides", "rows": [["first ride", "—"], ["second ride", "—"]]}
],
"flows": [
{
"id": "race",
"label": "Two riders, one driver",
"nodes": ["gw3", "dis3", "loc3", "ds3", "db3"],
"steps": [
{"el": "t3-r-gw", "payload": "r_5120 and r_6604 · same second", "set": {"drv.driver": "d_3381", "drv.status": "available", "drv.version": "812", "rides.first ride": "rd_40917 · matching", "rides.second ride": "rd_40922 · matching"}, "text": "The same two riders outside Union Station ask in the same second."},
{"el": "t3-gw-dis", "payload": "two requests · two dispatch servers", "text": "Two dispatch servers take one each."},
{"el": "t3-dis-loc", "payload": "available near dp3wjx · ×2", "text": "Both ask for candidates."},
{"el": "t3-loc-dis", "payload": "both: d_3381 is fastest", "ms": 31, "text": "As before, both get the same candidates and both find d_3381 is fastest, 4 minutes."},
{"el": "t3-dis-ds", "payload": "A and B: offered(…) if available @ v812", "text": "This time, before offering anything, each sends a conditional write to the driver state store: set d_3381 to offered, with my offer, if it is available at version 812."},
{"el": "t3-ds-dis", "payload": "A: ok · v813 · B: conflict", "ms": 3, "set": {"drv.status": "offered(of_771) · until 23:04:15", "drv.version": "813"}, "text": "The store applies writes to one driver one at a time. A's arrives first and succeeds. When B's is applied, d_3381 is no longer available, so it fails. B has sent nothing to anyone."},
{"el": "t3-dis-ds", "payload": "B: offered(of_772) to d_5007 if available", "text": "B moves to its second-fastest candidate, d_5007, 5 minutes away, and claims them the same way."},
{"el": "t3-ds-dis", "payload": "B: ok", "ms": 3, "text": "d_5007 was free. Each rider now has one driver claimed, and each driver one ride."},
{"el": "t3-dis-gw", "payload": "of_771 → d_3381 · of_772 → d_5007", "text": "Each offer goes to its driver."},
{"el": "t3-d-gw", "payload": "d_3381: accept of_771", "text": "d_3381 sees exactly one offer, and accepts."},
{"el": "t3-gw-dis", "payload": "accept of_771", "text": "The accept reaches dispatch."},
{"el": "t3-dis-db", "payload": "rd_40917: driver_assigned if matching", "text": "Dispatch changes the ride from matching to driver_assigned, on the condition that it is still matching."},
{"el": "t3-db-dis", "payload": "ok", "ms": 5, "set": {"rides.first ride": "rd_40917 · d_3381"}, "text": "It was."},
{"el": "t3-dis-ds", "payload": "en_route(rd_40917) if offered(of_771)", "text": "Then the driver: from offered with this offer to en route."},
{"el": "t3-ds-dis", "payload": "ok · v814", "ms": 3, "set": {"drv.status": "en_route(rd_40917)", "drv.version": "814", "rides.second ride": "rd_40922 · d_5007 offered"}, "text": "Done. The location service's copy of d_3381's status updates from the store's change feed a moment later."},
{"el": "t3-gw-r", "payload": "r_5120: d_3381 · 4 min", "text": "r_5120 gets d_3381. r_6604 waits a few more seconds for d_5007. Nobody is promised a driver they won't get."}
]
},
{
"id": "timeout",
"label": "A driver who doesn't answer",
"nodes": ["gw3", "dis3", "ds3"],
"steps": [
{"el": "t3-dis-ds", "payload": "d_4410: offered(of_780) if available · expires 23:10:15", "set": {"drv.driver": "d_4410", "drv.status": "available", "drv.version": "77", "rides.first ride": "rd_41005 · matching", "rides.second ride": "—"}, "text": "Dispatch claims d_4410 for ride rd_41005, with an offer that expires in 15 seconds."},
{"el": "t3-ds-dis", "payload": "ok · v78", "ms": 3, "set": {"drv.status": "offered(of_780)", "drv.version": "78"}, "text": "Claimed."},
{"el": "t3-dis-gw", "payload": "offer of_780 → d_4410", "text": "The offer goes out."},
{"el": "t3-gw-d", "payload": "offer of_780 · 15 s", "text": "d_4410's phone is face down on the passenger seat. Nobody taps anything."},
{"el": "t3-dis-ds", "payload": "15 s: available if offered(of_780)", "ms": 15000, "text": "Dispatch's timer for of_780 fires. It sets d_4410 back to available, on the condition that they still hold this offer. Had the dispatch server crashed, the sweeper would have found the offer past its expiry and done the same a few seconds later."},
{"el": "t3-ds-dis", "payload": "ok · d_4410 available", "ms": 3, "set": {"drv.status": "available · 1 expired in a row", "drv.version": "79"}, "text": "d_4410 is available again. Three expired offers in a row and they'd be set offline, so they stop holding up riders."},
{"el": "t3-dis-ds", "payload": "d_2071: offered(of_781) if available", "text": "Dispatch claims the next candidate, d_2071."},
{"el": "t3-ds-dis", "payload": "ok", "ms": 3, "set": {"drv.driver": "d_2071", "drv.status": "offered(of_781)", "drv.version": "1,204"}, "text": "Claimed."},
{"el": "t3-dis-gw", "payload": "offer of_781 → d_2071", "text": "The offer goes to d_2071."},
{"el": "t3-d-gw", "payload": "d_2071 accepts after 6 s", "set": {"drv.status": "en_route(rd_41005)", "drv.version": "1,206", "rides.first ride": "rd_41005 · d_2071"}, "text": "d_2071 accepts. The ride and driver states change as before."},
{"el": "t3-gw-r", "payload": "matched · after 22 s", "text": "The rider waited 22 seconds instead of forever. One unresponsive driver costs 15 seconds, not the ride."}
]
},
{
"id": "cross",
"label": "An accept and a cancel cross",
"nodes": ["gw3", "dis3", "ds3", "db3"],
"steps": [
{"el": "t3-gw-d", "payload": "offer of_790 · rd_40950 → d_3381", "set": {"drv.driver": "d_3381", "drv.status": "offered(of_790)", "drv.version": "830", "rides.first ride": "rd_40950 · matching", "rides.second ride": "—"}, "text": "d_3381 has an offer for ride rd_40950."},
{"el": "t3-r-gw", "payload": "cancel rd_40950", "text": "9 seconds in, the rider decides to take the train and cancels, at the same moment as the driver taps accept."},
{"el": "t3-gw-dis", "payload": "cancel, then accept · 20 ms apart", "text": "Both reach dispatch, the cancel 20 milliseconds first."},
{"el": "t3-dis-db", "payload": "cancel: cancelled if matching", "text": "Both actions change the ride first, so the ride row decides. The cancel sets it from matching to cancelled."},
{"el": "t3-db-dis", "payload": "ok", "ms": 5, "set": {"rides.first ride": "rd_40950 · cancelled"}, "text": "It succeeds."},
{"el": "t3-dis-db", "payload": "accept: driver_assigned if matching", "text": "The accept tries to set the ride to driver_assigned, on the condition that it is still matching."},
{"el": "t3-db-dis", "payload": "conflict · cancelled", "ms": 5, "text": "It isn't. The accept fails before it has changed anything about the driver."},
{"el": "t3-dis-ds", "payload": "available if offered(of_790)", "text": "Dispatch withdraws the offer: d_3381 back to available, on the condition that they still hold of_790."},
{"el": "t3-ds-dis", "payload": "ok · v831", "ms": 3, "set": {"drv.status": "available", "drv.version": "831"}, "text": "Done."},
{"el": "t3-dis-gw", "payload": "409 · rider cancelled", "text": "The driver is told the rider cancelled and is available again at once. The same checks turn away an accept that arrives after an offer expired: the driver no longer holds that offer, so the condition fails. The rider and driver can never end up disagreeing about whether the ride is on."}
]
}
]
}
</script>
<div class="diagram-caption">Every driver's state lives in one store that applies conditional writes in order. Dispatch claims a driver there before offering the ride, and every offer expires after 15 seconds. Accepts and cancels both change the ride's status conditionally, so exactly one of them wins.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw3">
<strong>If a gateway server fails:</strong> phones reconnect elsewhere in a few seconds. An offer sent while a driver was reconnecting is resent when they're back if it hasn't expired; otherwise it expires as usual.
</div>
<div class="failure-impact is-hidden" data-component="loc3">
<strong>If the location service fails:</strong> no candidates until a replacement has filled up from incoming updates, about 8 seconds. Every claim is checked against the driver state store, so nothing it had wrong can cause a double assignment.
</div>
<div class="failure-impact is-hidden" data-component="dis3">
<strong>If a dispatch server fails:</strong> its offers are in the driver state store with their expiry times, so the sweeper releases the unanswered ones. Its rides are still matching in the database; another dispatch server picks up any ride that has been matching for more than 5 seconds without an open offer.
</div>
<div class="failure-impact is-hidden" data-component="ds3">
<strong>If one driver state replica fails:</strong> the other two carry on. If two zones are lost, the store stops accepting writes rather than risk two answers, and no new rides are matched until it's back. Rides already in progress carry on.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the rides database fails:</strong> it fails over to a replica in seconds. During that time new requests and accepts fail and are retried by the phones with the same IDs.
</div>
</div>

Every assignment is now exclusive and every offer ends. But dispatch still takes each rider on their own, the moment they ask, and gives them the best driver for them right then. At 22:10 a hockey game ends at the United Center, 20,000 people walk out, and 3,000 ask for rides in 15 minutes from within a kilometre. About 60 drivers are free nearby. Taking riders one at a time hands out the closest drivers to whoever asked first, even when that leaves the next rider with a driver 9 minutes away. And the price doesn't change, so requests keep coming far faster than drivers can.

<!-- stage:4:4. Batches and Surge -->

## Stage 4 — Match in Batches, Price the Crowd

- **Requests wait up to 2 seconds for a batch.** Every 2 seconds, for each area of the city, a matcher takes all waiting riders and all free drivers nearby, and assigns them together. Each driver is claimed exactly as in Stage 3.
- **The batch minimizes total waiting.** For each rider it takes the 10 fastest drivers by ETA, then chooses the assignment with the smallest total pickup time across everyone in the batch. Riders who have already waited longest get a weight, so nobody is passed over again and again.
- **Drivers about to finish count.** A driver whose current trip ends within 3 minutes, close to a pickup, is a candidate too. Their next ride is queued and shown when they drop off.
- **A pricing service sets surge per cell.** Every minute it compares demand in each cell and its neighbours, from quotes and requests, with supply, the free drivers and those finishing soon. When demand is well above supply, the price in that cell rises by a multiplier, at most 0.4 a minute, up to 3.0×. As the crowd clears, it falls the same way.
- **The quote holds the price.** The fare a rider sees is fixed for 2 minutes. They choose whether to pay it or wait.
- **Drivers see where the surge is.** Each driver's app gets a map of surge cells every minute, so drivers nearby head towards the crowd.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="Rider quotes go through the gateway to a pricing service that compares demand with free drivers per cell; ride requests go to a matcher that collects a batch every two seconds, takes candidates from the location service and driving times from the ETA service, and claims drivers in the driver state store">
  <rect x="20" y="40" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="66" text-anchor="middle" class="d-actor-label" font-size="12">Driver App</text>
  <text x="80" y="83" text-anchor="middle" class="d-label-muted" font-size="9">offers + surge map</text>
  <rect x="20" y="280" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="306" text-anchor="middle" class="d-actor-label" font-size="12">Rider App</text>
  <text x="80" y="323" text-anchor="middle" class="d-label-muted" font-size="9">quote, then request</text>
  <g data-fail-toggle="gw4">
    <rect x="180" y="150" width="130" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="245" y="190" text-anchor="middle" class="d-actor-label" font-size="12">Gateway</text>
    <text x="245" y="208" text-anchor="middle" class="d-label-muted" font-size="9">open connections</text>
  </g>
  <g data-fail-toggle="loc4">
    <rect x="370" y="20" width="170" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="455" y="52" text-anchor="middle" class="d-actor-label" font-size="12">Location Service</text>
    <text x="455" y="70" text-anchor="middle" class="d-label-muted" font-size="9">free + finishing soon</text>
  </g>
  <g data-fail-toggle="mt4">
    <rect x="370" y="140" width="170" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="455" y="172" text-anchor="middle" class="d-actor-label" font-size="12">Matcher</text>
    <text x="455" y="190" text-anchor="middle" class="d-label-muted" font-size="9">a batch every 2 s per area</text>
    <text x="455" y="205" text-anchor="middle" class="d-label-muted" font-size="9">least total waiting</text>
  </g>
  <g data-fail-toggle="pr4">
    <rect x="370" y="290" width="170" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="455" y="322" text-anchor="middle" class="d-actor-label" font-size="12">Pricing</text>
    <text x="455" y="340" text-anchor="middle" class="d-label-muted" font-size="9">demand ÷ supply per cell</text>
  </g>
  <g data-fail-toggle="eta4">
    <rect x="630" y="140" width="210" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="735" y="180" text-anchor="middle" class="d-actor-label" font-size="12">ETA Service</text>
    <text x="735" y="198" text-anchor="middle" class="d-label-muted" font-size="9">riders × their nearest drivers</text>
  </g>
  <g data-fail-toggle="ds4">
    <rect x="630" y="290" width="210" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="735" y="322" text-anchor="middle" class="d-actor-label" font-size="12">Driver State</text>
    <text x="735" y="340" text-anchor="middle" class="d-label-muted" font-size="9">conditional claims, as in Stage 3</text>
  </g>
  <line id="u4-d-gw" x1="142" y1="62" x2="216" y2="146" class="d-msg d-request" data-depends-on="gw4" marker-end="url(#arrowR4)"></line>
  <line id="u4-gw-d" x1="236" y1="146" x2="142" y2="90" class="d-msg d-response" data-depends-on="gw4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-r-gw" x1="142" y1="300" x2="216" y2="254" class="d-msg d-request" data-depends-on="gw4" marker-end="url(#arrowR4)"></line>
  <line id="u4-gw-r" x1="236" y1="254" x2="142" y2="326" class="d-msg d-response" data-depends-on="gw4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-gw-mt" x1="312" y1="180" x2="366" y2="180" class="d-msg d-request" data-depends-on="gw4 mt4" marker-end="url(#arrowR4)"></line>
  <line id="u4-mt-gw" x1="366" y1="212" x2="312" y2="212" class="d-msg d-response" data-depends-on="gw4 mt4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-gw-pr" x1="290" y1="252" x2="366" y2="306" class="d-msg d-request" data-depends-on="gw4 pr4" marker-end="url(#arrowR4)"></line>
  <line id="u4-pr-gw" x1="366" y1="334" x2="272" y2="254" class="d-msg d-response" data-depends-on="gw4 pr4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-mt-loc" x1="440" y1="136" x2="440" y2="104" class="d-msg d-request" data-depends-on="mt4 loc4" marker-end="url(#arrowR4)"></line>
  <line id="u4-loc-mt" x1="470" y1="104" x2="470" y2="136" class="d-msg d-response" data-depends-on="mt4 loc4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-mt-eta" x1="542" y1="175" x2="626" y2="175" class="d-msg d-request" data-depends-on="mt4 eta4" marker-end="url(#arrowR4)"></line>
  <line id="u4-eta-mt" x1="626" y1="208" x2="542" y2="208" class="d-msg d-response" data-depends-on="mt4 eta4" marker-end="url(#arrowR4r)"></line>
  <line id="u4-mt-ds" x1="542" y1="226" x2="636" y2="286" class="d-msg d-request" data-depends-on="mt4 ds4" marker-end="url(#arrowR4)"></line>
  <line id="u4-ds-mt" x1="626" y1="300" x2="542" y2="242" class="d-msg d-response" data-depends-on="mt4 ds4" marker-end="url(#arrowR4r)"></line>
  <path id="u4-loc-pr" d="M542,60 L590,60 L590,350 L544,350" class="d-msg d-request" data-depends-on="loc4 pr4" marker-end="url(#arrowR4)"></path>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play two riders and two drivers, then the game letting out, then a driver about to drop off</text>
  <defs>
    <marker id="arrowR4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "batch", "title": "Batch", "rows": [["riders", "—"], ["drivers", "—"], ["total pickup time", "—"]]},
{"id": "surge", "title": "Cell dp3wkb · United Center", "rows": [["demand", "—"], ["supply", "—"], ["multiplier", "—"]]}
],
"flows": [
{
"id": "pair",
"label": "Two riders, two drivers",
"nodes": ["gw4", "mt4", "loc4", "eta4", "ds4"],
"steps": [
{"el": "u4-r-gw", "payload": "R1 and R2 · 1 s apart", "set": {"batch.riders": "—", "batch.drivers": "—", "batch.total pickup time": "—", "surge.demand": "—", "surge.supply": "—", "surge.multiplier": "—"}, "text": "Two riders a few blocks apart in the West Loop ask for rides, one second apart. Call them R1 and R2."},
{"el": "u4-gw-mt", "payload": "both join the 23:20:02 batch", "set": {"batch.riders": "R1, R2"}, "text": "Neither is matched on arrival. Both wait for the next batch, at most 2 seconds."},
{"el": "u4-mt-loc", "payload": "free drivers near both pickups", "text": "When the batch runs, the matcher asks for free drivers near all its riders at once."},
{"el": "u4-loc-mt", "payload": "d_1102, d_1188", "ms": 1, "set": {"batch.drivers": "d_1102, d_1188"}, "text": "Two are free: d_1102 and d_1188."},
{"el": "u4-mt-eta", "payload": "2 riders × 2 drivers", "text": "The matcher asks for every rider-to-driver driving time."},
{"el": "u4-eta-mt", "payload": "R1: d_1102 2 min, d_1188 3 min · R2: d_1102 2 min, d_1188 9 min", "ms": 30, "text": "d_1102 is 2 minutes from either rider. d_1188 is 3 minutes from R1 but 9 from R2, across the river and one-way streets."},
{"el": "u4-mt-ds", "payload": "R1 → d_1188 · R2 → d_1102", "set": {"batch.total pickup time": "5 min · one at a time: 11"}, "text": "Taking riders one at a time, as in Stage 3, R1 would get the fastest driver, d_1102, 2 minutes, and R2 would be left with d_1188, 9 minutes: 11 minutes in total. Looking at both together, R1 takes d_1188, 3 minutes, and R2 takes d_1102, 2 minutes: 5 in total. R1 waits one minute longer, and R2 waits seven fewer. The matcher claims both drivers with the same conditional writes as before."},
{"el": "u4-ds-mt", "payload": "both claims ok", "ms": 3, "text": "Both were free."},
{"el": "u4-mt-gw", "payload": "two offers", "text": "The offers go out."},
{"el": "u4-gw-d", "payload": "of_802 → d_1188 · of_803 → d_1102", "text": "The 2-second wait for the batch cost each rider up to 2 seconds. It saved one of them 7 minutes."}
]
},
{
"id": "game",
"label": "The game lets out",
"nodes": ["gw4", "pr4", "loc4", "mt4", "ds4"],
"steps": [
{"el": "u4-r-gw", "payload": "quotes from dp3wkb: 40/min → 900/min", "set": {"batch.riders": "—", "batch.drivers": "—", "batch.total pickup time": "—", "surge.demand": "900 quotes/min", "surge.supply": "—", "surge.multiplier": "1.0×"}, "text": "22:10. The game at the United Center ends and 20,000 people walk out. Within minutes, 900 a minute open the app in cell dp3wkb and the cells around it to check the price."},
{"el": "u4-gw-pr", "payload": "quote · pickup dp3wkb", "text": "Each quote goes to the pricing service."},
{"el": "u4-loc-pr", "payload": "dp3wkb + ring: 60 free or finishing", "set": {"surge.supply": "60 drivers"}, "text": "Every minute, pricing compares each cell's demand with its supply: the free drivers in the cell and its neighbours, plus those finishing a trip there within 5 minutes. Here that's 60 drivers for 900 people a minute."},
{"el": "u4-pr-gw", "payload": "surge 2.1× · q_9310 · $31.50 · held 2 min", "ms": 2, "set": {"surge.multiplier": "1.0 → 1.4 → 1.8 → 2.1×"}, "text": "The multiplier in dp3wkb climbs by at most 0.4 a minute, from 1.0 to 2.1 over three minutes. A ride that would cost $15.00 is quoted at $31.50, and that price holds for 2 minutes."},
{"el": "u4-gw-r", "payload": "$31.50 · or wait for the price to drop", "set": {"surge.demand": "900 → 140 requests/min"}, "text": "Some riders pay it. Many walk to the train, wait at a bar, or share with friends. Requests fall from what would have been 900 a minute to about 140."},
{"el": "u4-gw-d", "payload": "surge map: dp3wkb 2.1×", "set": {"surge.supply": "60 → 170 drivers"}, "text": "Drivers' apps show dp3wkb in deep colour. Drivers within a few kilometres head over, and over ten minutes supply grows from 60 to 170."},
{"el": "u4-gw-mt", "payload": "140 requests/min · a batch every 2 s", "set": {"batch.riders": "~5 per batch", "batch.drivers": "~10 per batch"}, "text": "Each batch now has about 5 riders and 10 drivers, and the matcher pairs them for the least total waiting."},
{"el": "u4-mt-ds", "payload": "claims, as in Stage 3", "text": "The claims are the same conditional writes. With every batch wanting the same few drivers, the conditions are what keep each driver to one ride."},
{"el": "u4-ds-mt", "payload": "ok", "ms": 3, "set": {"batch.total pickup time": "median wait 6 min"}, "text": "Riders who requested wait about 6 minutes, instead of most of 3,000 people being told there are no cars."},
{"el": "u4-pr-gw", "payload": "22:40 · 1.0×", "set": {"surge.demand": "60 quotes/min", "surge.multiplier": "1.0×"}, "text": "By 22:40 the crowd has cleared and the multiplier has stepped back down to 1.0."}
]
},
{
"id": "chain",
"label": "A driver about to drop off",
"nodes": ["gw4", "mt4", "loc4", "eta4", "ds4"],
"steps": [
{"el": "u4-r-gw", "payload": "r_7105 · pickup near Union Station", "set": {"batch.riders": "r_7105", "batch.drivers": "—", "batch.total pickup time": "—", "surge.demand": "—", "surge.supply": "—", "surge.multiplier": "—"}, "text": "A rider near Union Station asks for a ride."},
{"el": "u4-gw-mt", "payload": "batch 23:41:06", "text": "The request joins the next batch."},
{"el": "u4-mt-loc", "payload": "free, or finishing within 3 min", "text": "The matcher asks for free drivers and for drivers whose trip ends within 3 minutes near the pickup."},
{"el": "u4-loc-mt", "payload": "d_2071 free · d_6650 dropping off 400 m away", "ms": 1, "set": {"batch.drivers": "d_2071 (free), d_6650 (on trip)"}, "text": "The nearest free driver, d_2071, is across the river. d_6650 is on a trip that ends 400 metres from the pickup."},
{"el": "u4-mt-eta", "payload": "d_2071 → pickup · d_6650 → drop-off → pickup", "text": "For d_6650, the ETA is the rest of the current trip plus the drive from the drop-off to the pickup."},
{"el": "u4-eta-mt", "payload": "d_2071: 7 min · d_6650: 2 + 2 = 4 min", "ms": 30, "set": {"batch.total pickup time": "4 min"}, "text": "d_6650 will be there in 4 minutes. d_2071 would take 7."},
{"el": "u4-mt-ds", "payload": "d_6650: next_ride rd_41220 if on_trip(rd_41190), no next ride", "text": "The matcher queues the ride behind d_6650's current trip, on the condition that the trip is still going and nothing else is queued."},
{"el": "u4-ds-mt", "payload": "ok", "ms": 3, "text": "Queued."},
{"el": "u4-gw-d", "payload": "next ride · shown at drop-off", "text": "d_6650 sees the next ride when they drop off the current rider, and goes straight to it."},
{"el": "u4-gw-r", "payload": "driver in 4 min · finishing a trip nearby", "text": "The rider waits 4 minutes, not 7, and d_2071 stays free for someone on their side of the river. If d_6650's trip runs long, because the rider adds a stop, the queued ride goes back into the next batch."}
]
}
]
}
</script>
<div class="diagram-caption">Ride requests wait up to 2 seconds for a batch, and the matcher assigns each batch's riders to free drivers, and drivers about to finish, for the least total waiting. A pricing service compares demand with supply in each cell every minute and raises the price where demand is far ahead, which slows requests and draws drivers in.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw4">
<strong>If a gateway server fails:</strong> phones reconnect elsewhere in a few seconds, and requests are retried with the same IDs.
</div>
<div class="failure-impact is-hidden" data-component="loc4">
<strong>If the location service fails:</strong> batches have no drivers for about 8 seconds while a replacement fills up. Pricing keeps the last multipliers until supply counts return.
</div>
<div class="failure-impact is-hidden" data-component="mt4">
<strong>If the matcher fails:</strong> another takes over the area and runs the next batch from the waiting rides in the database. Riders lose one batch, 2 seconds.
</div>
<div class="failure-impact is-hidden" data-component="pr4">
<strong>If pricing fails:</strong> quotes use the last multiplier for each cell for up to 5 minutes, then fall back to 1.0×. Matching carries on.
</div>
<div class="failure-impact is-hidden" data-component="eta4">
<strong>If the ETA service fails:</strong> the matcher uses straight-line distance times the city's road factor. Matches are worse until it's back, and soon-finishing drivers are left out, since their ETAs can't be estimated.
</div>
<div class="failure-impact is-hidden" data-component="ds4">
<strong>If the driver state store loses its majority:</strong> no claims can be made, so no new matches. Rides in progress continue.
</div>
</div>

Chicago now handles a stadium emptying. But Chicago is one of 600 cities, and they all share one set of servers in one region. 375,000 position updates a second at the global peak is too much for one location service. A batch storm after a match in São Paulo competes with Friday night in Chicago for the same matchers. And when that region has an outage, every city on Earth stops matching at once, though a rider in Chicago and one in São Paulo never have anything to do with each other.

<!-- stage:5:5. A Cell for Each Market -->

## Stage 5 — A Cell for Each Market

- **The world is divided into markets.** A market is a metro area, drawn as a polygon: Chicago and its suburbs is one, Milwaukee another. A ride never needs anything from another market to be matched.
- **Each market runs in its own cell.** A cell is a full set of dispatch servers: location service, matcher, pricing and a driver state partition, in the region nearest the city. Chicago runs in us-central. Busy markets get a cell to themselves; small ones share ([Partitioning & Sharding](#/systems/partitioning-sharding)).
- **The gateway finds the market.** It keeps the market polygons in memory, finds which one a pickup or a driver's position falls in, and sends the request to that market's cell.
- **One matcher owns a market at a time.** It holds an owner lease in the driver state store, renewed every second, with an epoch number that rises at each change of owner. Every claim it writes carries its epoch, and the store rejects writes from an old one. A standby keeps up with the same positions and takes over when the lease lapses ([Distributed Lock Service](#/systems-case-studies/distributed-lock-service)).
- **A driver belongs to one market.** During a trip, it's the market the trip started in. After a trip ends in another market, the driver is handed over, and their positions go to the new market from then on.
- **A region outage moves its markets.** Each region has a paired region where its markets' driver state and rides are copied, a second or so behind. If a region is lost, its markets are started in the pair, and drivers' phones reconnect there ([Multi-Region & Disaster Recovery](#/systems/multi-region-dr)).

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 880 440" width="880" height="440" role="img" aria-label="Driver and rider apps connect to a gateway that finds each position's market; Chicago's cell in us-central holds the active matcher, a standby, the location service and the driver state store; a separate Milwaukee cell serves the neighbouring market">
  <rect x="380" y="20" width="480" height="300" rx="10" class="d-axis" fill="none" stroke-dasharray="5 4"></rect>
  <text x="620" y="311" text-anchor="middle" class="d-label-muted" font-size="9">Chicago market cell · us-central · 3 zones</text>
  <rect x="20" y="60" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="86" text-anchor="middle" class="d-actor-label" font-size="12">Driver App</text>
  <text x="80" y="103" text-anchor="middle" class="d-label-muted" font-size="9">belongs to one market</text>
  <rect x="20" y="260" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="286" text-anchor="middle" class="d-actor-label" font-size="12">Rider App</text>
  <text x="80" y="303" text-anchor="middle" class="d-label-muted" font-size="9">pickup decides the market</text>
  <g data-fail-toggle="gw5">
    <rect x="180" y="150" width="150" height="100" rx="6" class="d-actor-box" data-role="routing"></rect>
    <text x="255" y="185" text-anchor="middle" class="d-actor-label" font-size="12">Gateway</text>
    <text x="255" y="203" text-anchor="middle" class="d-label-muted" font-size="9">position → market</text>
    <text x="255" y="218" text-anchor="middle" class="d-label-muted" font-size="9">→ that market's cell</text>
  </g>
  <g data-fail-toggle="dis5">
    <rect x="410" y="60" width="180" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="500" y="90" text-anchor="middle" class="d-actor-label" font-size="12">Matcher + Pricing</text>
    <text x="500" y="108" text-anchor="middle" class="d-label-muted" font-size="9">owner · epoch 14</text>
  </g>
  <g data-fail-toggle="sb5">
    <rect x="410" y="200" width="180" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="500" y="230" text-anchor="middle" class="d-actor-label" font-size="12">Standby Matcher</text>
    <text x="500" y="248" text-anchor="middle" class="d-label-muted" font-size="9">warm · watches the lease</text>
  </g>
  <g data-fail-toggle="loc5">
    <rect x="650" y="60" width="180" height="80" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="740" y="90" text-anchor="middle" class="d-actor-label" font-size="12">Location Service</text>
    <text x="740" y="108" text-anchor="middle" class="d-label-muted" font-size="9">Chicago's 30,000 drivers</text>
  </g>
  <g data-fail-toggle="ds5">
    <rect x="650" y="200" width="180" height="80" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="740" y="230" text-anchor="middle" class="d-actor-label" font-size="12">Driver State</text>
    <text x="740" y="248" text-anchor="middle" class="d-label-muted" font-size="9">owner lease + claims</text>
  </g>
  <g data-fail-toggle="mk5">
    <rect x="380" y="350" width="300" height="56" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="530" y="374" text-anchor="middle" class="d-actor-label" font-size="12">Milwaukee Market Cell</text>
    <text x="530" y="391" text-anchor="middle" class="d-label-muted" font-size="9">its own matcher, location service, driver state</text>
  </g>
  <line id="v5-d-gw" x1="142" y1="84" x2="216" y2="146" class="d-msg d-request" data-depends-on="gw5" marker-end="url(#arrowR5)"></line>
  <line id="v5-gw-d" x1="236" y1="146" x2="142" y2="108" class="d-msg d-response" data-depends-on="gw5" marker-end="url(#arrowR5r)"></line>
  <line id="v5-r-gw" x1="142" y1="282" x2="216" y2="254" class="d-msg d-request" data-depends-on="gw5" marker-end="url(#arrowR5)"></line>
  <line id="v5-gw-r" x1="236" y1="254" x2="142" y2="306" class="d-msg d-response" data-depends-on="gw5" marker-end="url(#arrowR5r)"></line>
  <line id="v5-gw-dis" x1="332" y1="168" x2="406" y2="104" class="d-msg d-request" data-depends-on="gw5 dis5" marker-end="url(#arrowR5)"></line>
  <line id="v5-dis-gw" x1="406" y1="126" x2="332" y2="186" class="d-msg d-response" data-depends-on="gw5 dis5" marker-end="url(#arrowR5r)"></line>
  <line id="v5-gw-sb" x1="332" y1="226" x2="406" y2="236" class="d-msg d-request" data-depends-on="gw5 sb5" marker-end="url(#arrowR5)"></line>
  <line id="v5-dis-loc" x1="592" y1="88" x2="646" y2="88" class="d-msg d-request" data-depends-on="dis5 loc5" marker-end="url(#arrowR5)"></line>
  <line id="v5-loc-dis" x1="646" y1="114" x2="592" y2="114" class="d-msg d-response" data-depends-on="dis5 loc5" marker-end="url(#arrowR5r)"></line>
  <line id="v5-dis-ds" x1="592" y1="134" x2="660" y2="196" class="d-msg d-request" data-depends-on="dis5 ds5" marker-end="url(#arrowR5)"></line>
  <line id="v5-ds-sb" x1="646" y1="226" x2="594" y2="226" class="d-msg d-response" data-depends-on="ds5 sb5" marker-end="url(#arrowR5r)"></line>
  <line id="v5-sb-ds" x1="594" y1="254" x2="646" y2="254" class="d-msg d-request" data-depends-on="sb5 ds5" marker-end="url(#arrowR5)"></line>
  <path id="v5-gw-loc" d="M300,148 L300,36 L740,36 L740,56" class="d-msg d-request" data-depends-on="gw5 loc5" marker-end="url(#arrowR5)"></path>
  <path id="v5-gw-mk" d="M255,252 L255,378 L376,378" class="d-msg d-request" data-depends-on="gw5 mk5" marker-end="url(#arrowR5)"></path>
  <path id="v5-ds-mk" d="M780,282 L780,378 L684,378" class="d-msg d-request" data-depends-on="ds5 mk5" marker-end="url(#arrowR5)"></path>
  <text x="440" y="432" text-anchor="middle" class="d-label-muted" font-size="10">play a ride in Chicago, then Chicago's matcher failing, then a trip that ends in Milwaukee</text>
  <defs>
    <marker id="arrowR5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowR5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "mkt", "title": "Chicago market", "rows": [["cell", "us-central"], ["owner", "matcher A · epoch 14"], ["waiting rides", "—"]]},
{"id": "drv", "title": "Driver", "rows": [["driver", "—"], ["market", "—"], ["status", "—"]]}
],
"flows": [
{
"id": "ride",
"label": "A ride in Chicago",
"nodes": ["gw5", "dis5", "loc5", "ds5"],
"steps": [
{"el": "v5-r-gw", "payload": "POST /rides · pickup 41.8789, -87.6403", "set": {"mkt.cell": "us-central", "mkt.owner": "matcher A · epoch 14", "mkt.waiting rides": "180", "drv.driver": "—", "drv.market": "—", "drv.status": "—"}, "text": "The rider at Union Station asks for a ride."},
{"el": "v5-gw-dis", "payload": "→ market chicago · cell us-central", "text": "The gateway finds which of about 600 market polygons the pickup is in. It's Chicago, whose cell runs in us-central, and the request goes there."},
{"el": "v5-dis-loc", "payload": "free drivers near dp3wjx", "text": "Chicago's matcher asks Chicago's location service, which holds only Chicago's 30,000 drivers: 7,500 updates a second, easily one server and a replica."},
{"el": "v5-loc-dis", "payload": "10 candidates", "ms": 1, "text": "Candidates, as in every stage since 2."},
{"el": "v5-dis-ds", "payload": "offered(of_910) if available · epoch 14", "ms": 3, "set": {"drv.driver": "d_3381", "drv.market": "chicago", "drv.status": "offered(of_910)"}, "text": "The batch runs, and the claim carries the matcher's epoch."},
{"el": "v5-dis-gw", "payload": "offer → d_3381", "text": "The offer goes out through the gateway."},
{"el": "v5-gw-r", "payload": "driver in 4 min", "set": {"drv.status": "en_route"}, "text": "Everything about this ride stayed inside Chicago's cell. A rush in São Paulo or an outage in Frankfurt touches none of it."}
]
},
{
"id": "failover",
"label": "Chicago's matcher fails",
"nodes": ["gw5", "dis5", "sb5", "ds5"],
"steps": [
{"el": "v5-gw-dis", "payload": "batches every 2 s", "set": {"mkt.cell": "us-central", "mkt.owner": "matcher A · epoch 14", "mkt.waiting rides": "212 · 38 open offers", "drv.driver": "—", "drv.market": "—", "drv.status": "—"}, "text": "23:50, Friday. Chicago's matcher is running a batch every 2 seconds for each area of the city."},
{"el": "v5-dis-ds", "payload": "lease renewals stop", "text": "Its server crashes. It had been renewing the owner lease every second, and the lease lapses 3 seconds after the last renewal."},
{"el": "v5-ds-sb", "payload": "lease free → standby takes epoch 15", "ms": 3000, "set": {"mkt.owner": "matcher B · epoch 15"}, "text": "The standby has been watching the lease. It takes it, with epoch 15. From now on the store accepts claims only from epoch 15. If the old matcher was only paused and wakes up mid-batch, its epoch-14 claims are refused and it stops."},
{"el": "v5-sb-ds", "payload": "load 212 waiting rides · 38 open offers", "ms": 200, "text": "The new owner reads the waiting rides and the open offers, each with its expiry time, and restarts their timers from those times. It already receives Chicago's positions, so its view of drivers is current."},
{"el": "v5-gw-sb", "payload": "requests → matcher B", "text": "The gateway follows the owner record. Requests that arrived during the gap were held and are now delivered, with their original IDs."},
{"el": "v5-gw-r", "payload": "matched · ~4 s later than usual", "set": {"mkt.waiting rides": "212 → normal within a minute"}, "text": "Riders waiting during the failover see their match about 4 seconds late. No ride is lost, and no driver gets two, because every claim from both matchers went through the same conditional writes."}
]
},
{
"id": "milwaukee",
"label": "A trip that ends in Milwaukee",
"nodes": ["gw5", "loc5", "ds5", "mk5"],
"steps": [
{"el": "v5-d-gw", "payload": "d_9020 · trip rd_41330 to Milwaukee · 130 km", "set": {"mkt.cell": "us-central", "mkt.owner": "matcher B · epoch 15", "mkt.waiting rides": "—", "drv.driver": "d_9020", "drv.market": "chicago", "drv.status": "on_trip(rd_41330)"}, "text": "Driver d_9020 picks up a rider at Union Station going to downtown Milwaukee, 130 km north. Milwaukee is a different market, with its own cell."},
{"el": "v5-gw-loc", "payload": "positions → Chicago, all the way", "text": "During the trip, d_9020 belongs to Chicago, where the trip started. Their positions keep going to Chicago's location service even after they cross into Wisconsin, so the trip's route is recorded in one place."},
{"el": "v5-ds-mk", "payload": "complete rd_41330 · hand d_9020 to Milwaukee", "ms": 20, "set": {"drv.market": "milwaukee", "drv.status": "available"}, "text": "When the driver completes the trip, Chicago's cell sets d_9020's market to milwaukee, on the condition that they're still on that trip, and passes the driver's record to Milwaukee's cell, which adds them as available."},
{"el": "v5-gw-mk", "payload": "positions → Milwaukee", "text": "The gateway reads the driver's new market and sends their next position to Milwaukee's location service. Chicago's drops them after 20 seconds of silence, as it does any driver."},
{"el": "v5-gw-d", "payload": "available in Milwaukee · Milwaukee's surge map", "text": "d_9020 can take a ride in Milwaukee, or head home and be handed back to Chicago when they get there. At any moment, exactly one market can offer them a ride."}
]
}
]
}
</script>
<div class="diagram-caption">Each market runs in its own cell, in the region nearest the city, and the gateway sends every position and request to the right one. One matcher owns each market under a lease with an epoch, with a warm standby. Drivers who finish a trip in another market are handed over to it.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="gw5">
<strong>If a gateway server fails:</strong> phones reconnect to another in a few seconds. Every gateway has the same market map, so any of them can route any phone.
</div>
<div class="failure-impact is-hidden" data-component="dis5">
<strong>If Chicago's matcher fails:</strong> the standby takes the lease in about 3 seconds and carries on from the waiting rides and open offers in the store.
</div>
<div class="failure-impact is-hidden" data-component="sb5">
<strong>If the standby fails:</strong> nothing changes for riders. A new standby is started and catches up with positions within seconds.
</div>
<div class="failure-impact is-hidden" data-component="loc5">
<strong>If Chicago's location service fails:</strong> its replica, fed the same updates, takes over. If both fail, a new one fills up from incoming positions in about 8 seconds. No other market notices.
</div>
<div class="failure-impact is-hidden" data-component="ds5">
<strong>If Chicago's driver state store loses its majority:</strong> no new matches in Chicago until it recovers or the market is moved to its paired region. Other markets carry on.
</div>
<div class="failure-impact is-hidden" data-component="mk5">
<strong>If Milwaukee's cell fails:</strong> Milwaukee stops matching until it fails over. Drivers being handed to it stay in Chicago until it's back, and Chicago carries on unaffected.
</div>
</div>

This is the full design. Drivers keep a connection open and send their positions every 4 seconds. A location service holds the latest of each, in memory, grouped by fixed cells, and a stream keeps the routes of rides. Riders' requests wait up to 2 seconds for a batch. A matcher takes the free drivers near each batch, and those about to finish, gets their driving times, and assigns them for the least total waiting. Every driver is claimed with a conditional write before they're offered a ride, every offer expires after 15 seconds, and accepts and cancels are settled by a conditional change to the ride. Pricing raises the fare where demand is far ahead of supply, and holds each quote for 2 minutes. Every market runs in its own cell, owned by one matcher at a time under a lease, so a failure in one city or one region stays there.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Fixed cells for things that move

Places that don't move, as in [Proximity Search](#/systems-case-studies/proximity-search), suit a tree that splits cells until each holds 100 places: it's built once and changes slowly. Drivers move every 4 seconds. A tree would split and merge cells all night as cars gathered downtown and spread out again, and every change would touch several nodes. Fixed cells make an update almost free: most updates stay in one cell and only overwrite an entry, and the rest move one ID between two sets. The cost is that cells are the same size everywhere, so the search widens ring by ring in quiet areas. With only 30,000 drivers in a whole city, that's at most a few hundred entries checked.

| Cell scheme | Update cost | Neighbours | Used for |
|---|---|---|---|
| Geohash (this design) | One overwrite; occasionally a move between two sets | 8, at two different distances | Finding candidates |
| Hexagons | The same | 6, all the same distance | Surge areas and demand forecasts, where smooth areas matter |
| Quadtree | Splits and merges as drivers move | Varies | Better for places that don't move |

### The location update path

Each update carries a sequence number. The service ignores any that's lower than the last it kept, so a burst of old updates delivered after a reconnect can't move a driver backwards. Raw GPS in a city of tall buildings jumps by tens of metres, so the position is snapped to the nearest road in the direction of travel before it's stored; that's what makes the driver's heading meaningful to the ETA service. Phones send less often when the car is stopped and more often, every 2 seconds, when a driver is within a minute of the pickup, so the rider's map is smooth when it matters. The rider's app moves the car between updates using its speed and heading, then corrects it when the next one arrives.

### The assignment in a batch

A batch is an assignment problem: riders on one side, drivers on the other, a driving time for every pair, and the goal of pairing them for the least total. The exact Hungarian algorithm takes time that grows with the cube of the batch size, which is fine for a few hundred; with each rider limited to their 10 fastest drivers, most pairs drop out and it's faster still. Some refinements matter more than exactness:

- **Waiting time counts.** Each rider's pickup time is reduced by a bonus that grows the longer they've waited, so a rider who keeps losing to better pairings rises to the top.
- **The window is short.** Longer batches find better pairings but add their length to every rider's wait. 2 seconds is enough to gather the riders who arrive together after a game, and short enough that nobody notices it.
- **Unmatched riders roll over.** A rider with no driver in this batch is in the next one, with their waiting bonus growing.

### The driver state machine

| From | To | Who | Condition |
|---|---|---|---|
| `available` | `offered(o)` | Matcher | Still `available`, at the version it read |
| `offered(o)` | `available` | Timer, sweeper, decline, cancel | Still `offered(o)` |
| `offered(o)` | `en_route(r)` | Accept | Still `offered(o)`; ride `r` changed to `driver_assigned` first |
| `en_route(r)` | `on_trip(r)` | Driver starts the trip | Still `en_route(r)` |
| `on_trip(r)` | `available`, or `en_route` to the queued ride | Driver completes | Still `on_trip(r)` |
| any | `offline` | Driver, or three expired offers | — |

Every transition names the state it expects, so two things that try to change one driver at once can never both succeed. The table is the whole of the driver's lifecycle; anything not in it is refused.

### Surge

Each minute, for each cell and the ring of cells around it, pricing estimates demand, the quotes and requests in the last 5 minutes, and supply, the free drivers plus those finishing a trip there within 5 minutes. The target multiplier rises with the ratio: 1.0× while demand is under 1.2 times supply, then upwards to a cap of 3.0×. The actual multiplier moves towards the target by at most 0.4 a minute, so the price doesn't jump with every small swing. Smoothing over neighbouring cells stops a rider from walking 100 metres to escape it. During emergencies, such as a storm or an evacuation, surge is switched off for the affected area.

### Where a market ends

A ride is matched in the market where it's picked up. Near a boundary, the best driver may be just across it, in the neighbouring market. Markets are drawn around whole metro areas so this is rare, and along the few busy boundaries, such as a river between two cities, each market's location service also receives the positions of drivers within 2 km of its edge, read-only. A rider there can be offered such a driver, and the claim goes to the driver's own market's store, which is the only one that can change them.

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Waiting for a batch against matching at once

Every rider waits up to 2 seconds for the batch to run. In a quiet suburb at 4 a.m., there's never more than one rider in a batch and the wait buys nothing. The batch window is set per area by time of day: up to 2 seconds where riders arrive together, near zero where they don't.

### One matcher per market

A market is owned by one matcher, which keeps claims simple and failover clean. The biggest markets, with over 100,000 drivers, are split into zones, each with its own matcher, and riders near a zone's edge can be offered drivers from the next zone. That brings back some of the boundary problems that markets were drawn to avoid.

### Positions are always a little old

A position can be 4 seconds old when it's read, and the driver may have turned a corner since. ETAs are calculated from where the car probably is, using its speed and heading, but some matches go to a driver who has just passed the turning. Sending positions more often would cost phone battery and data for every driver, all night.

### Claims that fail

The location service's copy of who is available can be a moment behind the driver state store. In a crowd, several matchers' first choices are often the same driver, so some claims fail and fall to the next candidate. That costs a few milliseconds each and is safe, but a high rate of failed claims means matchers are working from stale data.

### Offers to one driver at a time

Offering a ride to one driver at a time costs up to 15 seconds for each who doesn't answer. Offering it to several at once and taking the first to accept would match faster, but all the others would tap accept and be told it's gone, and drivers stop trusting offers that disappear.

### Surge is unpopular

Raising prices in a crowd keeps cars available for those who need one most, and pulls drivers in. It's also the part of the system riders resent most. The cap, the smoothing and the quote that holds the price are there to keep it predictable, at the cost of reacting more slowly to real spikes.

### Drivers finishing nearby

Queuing a ride behind a trip that hasn't ended relies on the trip ending when expected. When the rider in the car adds a stop, the waiting rider's pickup slips and the queued ride goes back into a batch, now a few minutes late.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

Dispatch makes money move between strangers and puts them in a car together, so the risks are fraud by drivers or riders, and harm to either ([Security & Authentication](#/systems/security-authentication)).

### Fake positions

Apps that fake GPS let a driver appear in a surge area they aren't in, or stretch a trip's route to raise the fare. Each update is checked against the last: a jump that would need 300 km/h, a position off any road, or a phone whose reported position disagrees with the cell towers and Wi-Fi networks it sees, is flagged. Fares are calculated from the recorded route snapped to roads, compared with the expected route for the trip, and a trip much longer than expected is reviewed.

### Collusion and fake trips

A driver and a rider account controlled by the same person can create trips to collect sign-up bonuses or incentives. Trips where the driver and rider share a phone, payment card or home address, or where the same pair rides together again and again, are held back from incentives and reviewed.

### Rider and driver safety

Before a driver accepts, they see the pickup area and the fare, not the rider's name or exact address. After matching, each sees the other's first name and the car; phone calls and messages go through masked numbers, so neither learns the other's real number. Riders can share a live view of their trip with a friend, and a trip that stops unexpectedly or strays far from its route prompts a check-in.

### Tracking a driver through the app

The rider app shows cars moving nearby before anyone requests a ride. That view would let someone follow a particular driver through the city. The cars shown are a sample, their positions are delayed and rounded, and their IDs are random and change with every session, so no one can tell that two cars on two screens are the same driver.

### Abuse of requests

Requesting and cancelling rides over and over ties up drivers for nothing, and a competitor could do it to make cars look scarce. Cancellation fees after a grace period, limits on requests per account and per device, and blocking accounts that cancel almost every ride keep it rare ([Rate Limiting](#/systems/rate-limiting)).

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Matching**: time from request to accept at p50 and p99, the share of requests that end with no driver, and riders waiting right now, per market.
- **Offers**: acceptance rate, and the shares that expire and are declined.
- **Claims**: the rate of failed conditional claims per matcher.
- **Positions**: the age of positions in each location service, and the number of online drivers who have gone silent.
- **ETAs**: predicted against actual pickup times, per market.
- **Surge**: the share of rides at each multiplier, and how long cells stay surged.
- **Ownership**: lease changes per market, and the epoch of every market's owner.

([Observability](#/systems/observability))

### What to alert on

- **Any driver with two active rides, or any ride with two drivers.** This should never happen; it means a write got around the conditional checks. Page immediately.
- Time to match p99 above **60 seconds** in any market while free drivers are online there.
- Positions in a location service more than **10 seconds** old at p99.
- Failed claims above **10%** of attempts in a market.
- Expired offers above **25%** in a market, which usually means offers aren't reaching phones.
- A market changing owner more than twice in an hour.

### "Riders in one market are told there are no drivers, but drivers are online" — what happens?

Check the location service for that market: if positions are old or the driver count is low, updates aren't arriving, so look at the gateways and the market map. If positions are fresh, look at the copy of each driver's status: if drivers show as busy there but are available in the driver state store, its change feed has stopped. If both are right, look at the offers: a high expiry rate means offers are being sent but not received.

### "A driver was sent two rides" — what happens?

Pull both rides and the driver's state history from the store. Every change carries the epoch of the matcher that made it. Two changes with different epochs means an old owner kept writing after it lost the lease, and the store isn't checking epochs. Two changes that both succeeded from the same state means a write went around the conditional check. Stop matching in the market until the cause is found; rides in progress continue.

### "ETAs are wrong in one city" — what happens?

Compare predicted and actual pickup times by area. If they're wrong everywhere in the city, the ETA service may be on stale traffic data or a stale road map, so check when each was last loaded. If they're wrong in one area, look for a road closure or event the map doesn't know about, and for drivers whose snapped positions are on the wrong road, as on double-deck streets like Wacker Drive.
