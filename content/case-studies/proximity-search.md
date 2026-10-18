# Proximity Search

Proximity search answers questions like "coffee near me": given a point on the map, find the places closest to it, filtered by what the user wants and ranked by what they'd most likely pick. Each answer is small, and the data changes slowly. The hard parts are that location has two dimensions while database indexes sort along one, that places are packed thousands to a block in a city and kilometres apart in the countryside, and that hundreds of millions of people ask from wherever they are. This case study builds the nearby-places search for a maps and local-discovery app: 200 million places worldwide, half a billion searches a day, and answers in well under a tenth of a second.

<!-- tab:requirements:Requirements -->

## Requirements

This case study builds the service that finds places near a point and shows them as a list and as pins on a map. The running example is a user standing in Union Square, New York, looking for coffee, with a second user on a road in eastern Montana, where the nearest anything may be 30 kilometres away. Searching places by name (`joe's pizza`) is a text search problem ([Search & Indexing](#/systems/search-indexing)) and is left to that system; this design handles everything that depends on where the user is.

### Functional requirements

- **Find nearby places**: for a point, return the nearest places, up to 20 at a time, within a radius of at most 50 km.
- **Filter**: by category (`coffee`, `pharmacy`, `ev charger`), by open now, and by minimum rating.
- **Rank**: closer is better, but a much better-rated place a little farther away should come first.
- **Show places on a map**: for the area on screen, show the best places as pins, and update as the user pans and zooms.
- **Add, edit and close places**: owners and editors change places, and searches reflect it.

### Non-functional requirements

- **Latency:** server time under **100ms** at p99 for a search, and under **10ms** for the location lookup inside it.
- **Availability:** 99.99%. Search is used on the way somewhere; an outage strands people.
- **Freshness:** an edit appears in search within **5 minutes**. A place that has closed for good disappears within **1 minute**.
- **Scale:** **200 million** places and **500 million** searches a day, with peaks around meal times.
- **Privacy:** the service never keeps a user's precise location.

### In scope

Indexing locations, finding the nearest places, density from city centres to empty countryside, filters and ranking, keeping the index current as places change, caching shared answers, map tiles, and serving from several regions.

### Out of scope

**Searching by name**, beyond category words. **Directions and travel time**: distance here is straight-line. **Reviews**: ratings arrive from the reviews system as numbers. **Things that move**, such as drivers or delivery couriers, whose positions change every few seconds. **Drawing the base map**: streets, labels and terrain are separate map tiles.

<!-- tab:scale-estimates:Scale Estimates -->

## Scale Estimates

The whole world's places, stripped down to what a search needs, fit in one server's memory. What shapes the design is how unevenly they're spread, and how many people ask at once.

<div class="stat-grid">
<div class="stat-tile">
<div class="stat-tile-label">Places</div>
<div class="stat-tile-value">~200<span class="stat-tile-unit">M</span></div>
<div class="stat-tile-sub">~1KB each · ~200GB in the database</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Searches</div>
<div class="stat-tile-value">~500<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~18K/s at meal-time peaks</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Map tile loads</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">B/day</span></div>
<div class="stat-tile-sub">~90% answered by the CDN</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Location index</div>
<div class="stat-tile-value">~13<span class="stat-tile-unit">GB</span></div>
<div class="stat-tile-sub">64 bytes a place · in memory</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Edits</div>
<div class="stat-tile-value">~2<span class="stat-tile-unit">M/day</span></div>
<div class="stat-tile-sub">~25/s · reads outnumber them 700 to 1</div>
</div>
<div class="stat-tile">
<div class="stat-tile-label">Densest vs sparsest</div>
<div class="stat-tile-value">~25,000<span class="stat-tile-unit">×</span></div>
<div class="stat-tile-sub">places per km², Midtown vs the plains</div>
</div>
</div>

### Assumptions

- **100 million** people use the app each day and search about **5 times** each. Peaks around lunch and dinner are about **3 times** the average.
- A place's full record, with name, address, hours, photos' IDs and attributes, is about **1KB**.
- Around Union Square there are about **2,500 places per km²**, and about 1.5% of them sell coffee. In eastern Montana there's about **one place per 10 km²**.
- About 40 million people a day open the map and load about **50 tiles** each as they pan and zoom.
- Places change slowly: about **1%** are edited in a month, and a few thousand close each day.

### Requests

100 million users at 5 searches each is 500 million searches a day, about 5,800 a second on average and **about 18,000 a second** at peak. Map tiles add 2 billion requests a day, but a tile is the same for everyone who looks at that spot, so the CDN answers nearly all of them.

### The index

A search needs very little about each place: an 8-byte ID, latitude and longitude as two 4-byte numbers (good to about a metre), two category numbers, the rating, a review count, and the opening hours for each day of the week. With padding that's **64 bytes**, and 200 million of them is 12.8GB. The tree that organizes them adds a few hundred megabytes. **About 13GB** fits comfortably in a server with 64GB of memory, so every index server can hold the whole world.

### Density

Around Union Square, 100 places fit in a square about 200 metres across. In eastern Montana, 100 places are spread over 30,000 km². Any design that divides the world into cells of one fixed size will either put thousands of places in a city cell or leave nearly every rural cell empty.

<!-- tab:api-design:API Design -->

## API Design

The phone sends its position with every search. Places are returned with their own position, so the phone can redraw distances as the user walks.

### Nearby search

```
GET /v1/places/nearby?lat=40.7359&lng=-73.9906&category=coffee&open_now=true
                     &min_rating=4&radius_m=1500&limit=20
→ 200 {"results": [{"place_id": "pl_48213", "name": "Daybreak Coffee",
                    "lat": 40.7371, "lng": -73.9894, "distance_m": 160,
                    "rating": 4.6, "reviews": 812, "open_now": true}, …],
       "radius_m": 1500,
       "next": "c_7f2a"}
```

### Map tiles

```
GET /v1/tiles/coffee/16/19298/24634
→ 200 {"pins": [{"place_id": "pl_48213", "lat": 40.7371, "lng": -73.9894,
                 "rating": 4.6, "rank": 1}, …]}
Cache-Control: public, max-age=300
```

### Place details and edits

```
GET /v1/places/pl_48213
→ 200 {"place_id": "pl_48213", "name": "Daybreak Coffee", "address": "…",
       "hours": {"mon": [["07:00", "19:00"]], …}, "version": 7, …}

POST /v1/places
{"name": "Second Cup Roasters", "lat": 40.7365, "lng": -73.9897, "category": "coffee", …}
→ 201 {"place_id": "pl_90117", "status": "pending_review"}

PATCH /v1/places/pl_48213
{"hours": {"sun": [["08:00", "16:00"]]}, "version": 7}
→ 200 {"version": 8}
```

| Code | Meaning |
|---|---|
| `200` | Results, possibly an empty list |
| `201` | Place created, waiting for review |
| `400` | Latitude or longitude out of range, radius over 50 km, or limit over 50 |
| `404` | No such place |
| `409` | The place changed since the version the edit was based on |
| `429` | Over the caller's request rate |

### Why the details matter

**A position, not an address.** The phone already knows where it is. Turning an address into a position is a separate service, used only when someone types one.

**The radius is capped at 50 km.** A search has to stop somewhere. Without a cap, a request for something rare in an empty part of the world would search the whole planet.

**Results carry their positions.** The phone recomputes each distance from its own exact location as the user moves, and an answer cached for someone 100 metres away is still right after that correction.

**Tiles are named by zoom, column and row, not by what's on screen.** Every phone's screen covers a slightly different rectangle, so a request for "what's in my viewport" would never be asked twice. A tile at zoom 16, column 19298, row 24634 is the same square of New York for everyone, so it's cached once and shared.

**Edits name the version they started from.** Two editors changing the same place at once can't silently overwrite each other; the second gets `409` and sees the first's change.

**Empty is a normal answer.** No EV charger within 50 km is a result, not an error.

<!-- tab:data-model:Data Model -->

## Data Model

The places database holds everything about a place and is the only thing that's ever written to. Everything else is a copy, shaped for a particular way of reading.

### Places

```
places                                   -- relational DB, the source of truth
  place_id      TEXT PRIMARY KEY         -- pl_48213
  name          TEXT
  category_ids  INT[]                    -- coffee, bakery
  lat           DOUBLE
  lng           DOUBLE
  geohash6      TEXT                     -- dr5rsr, indexed (Stage 2 only)
  address       TEXT
  hours         JSONB                    -- per weekday, local time
  time_zone     TEXT                     -- America/New_York
  rating        FLOAT                    -- from the reviews system
  review_count  INT
  status        TEXT                     -- pending_review | open | closed_permanently
  version       INT
  updated_at    TIMESTAMP
```

### The change stream

```
place_changes                            -- every committed change, in order per place
  position      12_004_118_552
  place_id      pl_48213
  version       8
  op            upsert | remove
  summary       {lat, lng, categories, rating, reviews, hours}
```

### The location index (from Stage 3)

```
in memory on every index server, ~13GB
  quadtree
    node        bounds, 4 children or a leaf of ≤100 places
                category summary: one bit per category found anywhere below (from Stage 4)
  entry         64 bytes
    place_id    8 bytes
    lat, lng    4 + 4 bytes
    categories  2 × 2 bytes
    rating      1 byte  (tenths of a star)
    reviews     3 bytes
    hours       7 × (open, close) in minutes, local time
  applied_up_to stream position
```

### Caches (from Stage 5)

```
results cache    key-value store per region, 5 min TTL
  (geohash7 of user, category, filters, radius) → [place_id, lat, lng, score] × 20
                 dr5ru7v · coffee · open_now · 1500

recently removed per API server
  place_id → removed_at                  -- closures in the last 10 minutes

tiles            at the CDN, 5 min
  /tiles/{category}/{zoom}/{x}/{y} → up to 30 pins
```

### Why this storage

Places are edited by people, a few dozen times a second, and every edit must be checked against the version it started from: a relational table, with the change stream read from its commit log, so nothing committed is ever missed ([Databases: Relational](#/systems/databases-relational), [Log-Based Systems](#/systems/log-based-systems)). Searches need the opposite: tens of thousands a second, reading only position, category, rating and hours. So the index is a compact copy in memory, rebuilt from a snapshot on start-up and kept current from the stream. Shared answers and map tiles are copies of copies, kept for minutes in a cache and at the CDN, because the same blocks of the same cities are asked about over and over ([Caching](#/systems/caching)).

<!-- tab:architecture:Architecture:default -->

This case study builds proximity search up in five stages. Each stage fixes a specific failure of the one before. Use the sub-tabs to move between stages, and the flow chips inside each stage to follow one request at a time. Components with a pointer cursor are clickable — click one to see what breaks if it fails, then replay a flow to watch it happen.

<!-- stage:1:1. A Box of Latitudes -->

## Stage 1 — Ask the Database for a Box

The simplest proximity search keeps places in a table with a latitude and a longitude, and an index on latitude. To find places within 500 metres, it turns the circle into a box of latitudes and longitudes, asks the database for everything in the box, then keeps what's inside the circle and sorts it by distance.

```
SELECT place_id, name, lat, lng FROM places
WHERE lat BETWEEN 40.7314 AND 40.7404
  AND lng BETWEEN -73.9965 AND -73.9847
  AND 'coffee' = ANY(category_ids)
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="A phone sends its position to an app server, which asks the database for every place inside a box of latitudes and longitudes, then filters by distance">
  <rect x="20" y="115" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="141" text-anchor="middle" class="d-actor-label" font-size="12">Phone App</text>
  <text x="90" y="158" text-anchor="middle" class="d-label-muted" font-size="9">sends its position</text>
  <g data-fail-toggle="app1">
    <rect x="260" y="95" width="180" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="126" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="144" text-anchor="middle" class="d-label-muted" font-size="9">radius → lat/lng box</text>
    <text x="350" y="159" text-anchor="middle" class="d-label-muted" font-size="9">distance check + sort</text>
  </g>
  <g data-fail-toggle="db1">
    <rect x="560" y="95" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="144" text-anchor="middle" class="d-label-muted" font-size="9">places · 200M rows</text>
    <text x="660" y="159" text-anchor="middle" class="d-label-muted" font-size="9">indexed by latitude</text>
  </g>
  <line id="p1-u-app" x1="162" y1="133" x2="256" y2="133" class="d-msg d-request" data-depends-on="app1" marker-end="url(#arrowP1)"></line>
  <line id="p1-app-u" x1="256" y1="160" x2="162" y2="160" class="d-msg d-response" data-depends-on="app1" marker-end="url(#arrowP1r)"></line>
  <line id="p1-app-db" x1="442" y1="133" x2="556" y2="133" class="d-msg d-request" data-depends-on="app1 db1" marker-end="url(#arrowP1)"></line>
  <line id="p1-db-app" x1="556" y1="160" x2="442" y2="160" class="d-msg d-response" data-depends-on="app1 db1" marker-end="url(#arrowP1r)"></line>
  <text x="390" y="282" text-anchor="middle" class="d-label-muted" font-size="10">play coffee near Union Square, then the lunch peak, then a café opening</text>
  <defs>
    <marker id="arrowP1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP1r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "req", "title": "This search", "rows": [["near", "—"], ["rows read", "—"], ["results", "—"]]},
{"id": "db", "title": "Database", "rows": [["load", "—"]]}
],
"flows": [
{
"id": "coffee",
"label": "Coffee near Union Square",
"nodes": ["app1", "db1"],
"steps": [
{"el": "p1-u-app", "payload": "GET /nearby?lat=40.7359&lng=-73.9906&radius=500&category=coffee", "set": {"req.near": "Union Square, NYC", "req.rows read": "—", "req.results": "—", "db.load": "light"}, "text": "A user in Union Square, New York, asks for coffee within 500 metres."},
{"el": "p1-app-db", "payload": "lat 40.7314–40.7404 · lng -73.9965 – -73.9847", "text": "The app server turns the circle into a box. 500 metres is 0.0045° of latitude anywhere on Earth. Degrees of longitude get narrower towards the poles, so at New York's latitude 500 metres is 0.0059° of longitude."},
{"el": "p1-db-app", "payload": "180,000 rows read → 37 coffee in the box", "ms": 400, "set": {"req.rows read": "180,000"}, "text": "The index on latitude finds every place between those two latitudes. But that isn't a small box: it's a strip one kilometre tall running all the way around the world, through New York, Ohio, Utah, Turkey and northern China. 180,000 places are in it. The database fetches each one to check its longitude, and 2,500 are in the box, 37 of them coffee. That takes 400ms."},
{"el": "p1-app-db", "payload": "add an index on lng too?", "text": "An index on longitude doesn't help. It's a strip from pole to pole, through Manhattan, Colombia and Peru. The database can use one index or combine both strips, but either way it reads hundreds of thousands of entries to find the few thousand where they cross. A sorted index puts things that are near each other in one dimension together. Two places can share a latitude and be on opposite sides of the world."},
{"el": "p1-app-u", "payload": "31 coffee places within 500 m", "set": {"req.results": "31 within 500 m"}, "text": "The app server computes the distance to each of the 37, keeps the 31 inside the circle, and sorts them. The user waits about half a second."}
]
},
{
"id": "peak",
"label": "The lunch peak",
"nodes": ["app1", "db1"],
"steps": [
{"el": "p1-u-app", "payload": "~18,000 searches/s", "set": {"req.near": "everywhere", "req.rows read": "—", "req.results": "—", "db.load": "rising"}, "text": "At lunch on a weekday, people across the US and Europe search for places to eat. About 18,000 searches a second."},
{"el": "p1-app-db", "payload": "18,000 × ~150,000 rows", "text": "Every one reads a strip around the world. That's billions of rows a second, against a database that can read a few million."},
{"el": "p1-db-app", "payload": "queue grows · 6 s", "ms": 6000, "set": {"db.load": "overloaded · queries waiting"}, "text": "Queries pile up behind each other. Answers take seconds, and the same database is also trying to save edits."},
{"el": "p1-app-u", "payload": "timeout", "set": {"req.results": "timed out"}, "text": "Searches time out. The problem isn't the volume of places, it's that the index can't find the ones near a point without reading a huge number that aren't."}
]
},
{
"id": "open",
"label": "A café opens",
"nodes": ["app1", "db1"],
"steps": [
{"el": "p1-u-app", "payload": "POST /places · Second Cup Roasters", "set": {"req.near": "—", "req.rows read": "—", "req.results": "—", "db.load": "light"}, "text": "An owner adds a new café on East 16th Street."},
{"el": "p1-app-db", "payload": "INSERT … lat 40.7365, lng -73.9897", "text": "The app server inserts one row."},
{"el": "p1-db-app", "payload": "committed", "ms": 3, "text": "It's committed in a few milliseconds."},
{"el": "p1-app-u", "payload": "201 · visible now", "set": {"req.results": "in the next search"}, "text": "The very next search sees it, because searches read the same table. This part is simple, and it's worth keeping: the database is the one place where the truth about places lives."}
]
}
]
}
</script>
<div class="diagram-caption">The app server turns a radius into a box of latitudes and longitudes and asks the database for everything in it. The index on latitude finds a strip around the whole world, which the database then narrows down row by row.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app1">
<strong>If the app server fails:</strong> no searches and no edits until it's back, or until another server takes its traffic.
</div>
<div class="failure-impact is-hidden" data-component="db1">
<strong>If the database fails:</strong> nothing works. Searches and edits both need it.
</div>
</div>

A database index sorts along one line, and location has two dimensions. Sorting by latitude keeps places together only along a strip around the world. What's needed is one value per place that keeps places near each other on the map near each other in the sort, so that "near this point" becomes a short range of that value.

<!-- stage:2:2. Geohash Cells -->

## Stage 2 — Cut the World into Cells

- **Each place gets a geohash.** The world is halved again and again, alternating between longitude and latitude, and each halving adds one bit: 0 for the west or south half, 1 for the east or north. Every 5 bits become one character. Union Square is in cell `dr5rsr`.
- **Longer codes are smaller cells.** Each character divides a cell into 32. At New York's latitude, a 6-character cell is about **610 metres tall and 930 metres wide**; a 5-character cell is about 4.9 km by 3.7 km.
- **Cells that share a prefix are near each other.** `dr5rsr` and `dr5rsq` are side by side. So the places table gets a `geohash6` column with an ordinary index, and each cell's places sit together in it.
- **A search reads 9 cells.** The app server picks the precision whose cells are at least as big as the radius, then reads the user's cell and its 8 neighbours. The circle can't reach beyond them.
- **Then it filters and sorts, as before.** It keeps places within the radius and sorts them by distance.

```
SELECT place_id, name, lat, lng FROM places
WHERE geohash6 IN ('dr5rsr', 'dr5ru2', 'dr5ru8', 'dr5rsx', 'dr5rsw',
                   'dr5rsq', 'dr5rsn', 'dr5rsp', 'dr5ru0')
  AND 'coffee' = ANY(category_ids)
```

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 780 290" width="780" height="290" role="img" aria-label="A phone sends its position to an app server, which works out the geohash cell and its eight neighbours, and asks the database for every place in those nine cells">
  <rect x="20" y="115" width="140" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="90" y="141" text-anchor="middle" class="d-actor-label" font-size="12">Phone App</text>
  <text x="90" y="158" text-anchor="middle" class="d-label-muted" font-size="9">sends its position</text>
  <g data-fail-toggle="app2">
    <rect x="260" y="95" width="180" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="350" y="126" text-anchor="middle" class="d-actor-label" font-size="12">App Server</text>
    <text x="350" y="144" text-anchor="middle" class="d-label-muted" font-size="9">position → geohash cell</text>
    <text x="350" y="159" text-anchor="middle" class="d-label-muted" font-size="9">+ 8 neighbours</text>
  </g>
  <g data-fail-toggle="db2">
    <rect x="560" y="95" width="200" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="660" y="126" text-anchor="middle" class="d-actor-label" font-size="12">Database</text>
    <text x="660" y="144" text-anchor="middle" class="d-label-muted" font-size="9">places</text>
    <text x="660" y="159" text-anchor="middle" class="d-label-muted" font-size="9">indexed by geohash6</text>
  </g>
  <line id="p2-u-app" x1="162" y1="133" x2="256" y2="133" class="d-msg d-request" data-depends-on="app2" marker-end="url(#arrowP2)"></line>
  <line id="p2-app-u" x1="256" y1="160" x2="162" y2="160" class="d-msg d-response" data-depends-on="app2" marker-end="url(#arrowP2r)"></line>
  <line id="p2-app-db" x1="442" y1="133" x2="556" y2="133" class="d-msg d-request" data-depends-on="app2 db2" marker-end="url(#arrowP2)"></line>
  <line id="p2-db-app" x1="556" y1="160" x2="442" y2="160" class="d-msg d-response" data-depends-on="app2 db2" marker-end="url(#arrowP2r)"></line>
  <text x="390" y="282" text-anchor="middle" class="d-label-muted" font-size="10">play coffee near Union Square, then standing at a cell's edge, then a road in eastern Montana</text>
  <defs>
    <marker id="arrowP2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP2r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "req", "title": "This search", "rows": [["user's cell", "—"], ["cells read", "—"], ["rows read", "—"], ["results", "—"]]}
],
"flows": [
{
"id": "coffee",
"label": "Coffee near Union Square",
"nodes": ["app2", "db2"],
"steps": [
{"el": "p2-u-app", "payload": "GET /nearby?lat=40.7359&lng=-73.9906&radius=500&category=coffee", "set": {"req.user's cell": "—", "req.cells read": "—", "req.rows read": "—", "req.results": "—"}, "text": "The same user, in Union Square, asks for coffee within 500 metres."},
{"el": "p2-app-db", "payload": "geohash6 IN (dr5rsr + 8 neighbours)", "set": {"req.user's cell": "dr5rsr · 610 m × 930 m", "req.cells read": "9 · about 5 km²"}, "text": "The app server encodes the position as a geohash. A 6-character cell here is 610 metres tall and 930 metres wide, bigger than 500 metres both ways, so a 500-metre circle around anyone in dr5rsr stays inside dr5rsr and its 8 neighbours. It asks for all nine."},
{"el": "p2-db-app", "payload": "12,000 rows · 9 short ranges", "ms": 30, "set": {"req.rows read": "12,000"}, "text": "The index on geohash6 keeps each cell's places together, so each cell is one short range read. Nine ranges, about 12,000 places. That's 30ms instead of 400."},
{"el": "p2-app-u", "payload": "31 coffee places within 500 m", "set": {"req.results": "31 within 500 m"}, "text": "The app server keeps the coffee places inside the circle, the same 31 as before, and sorts them by distance. In a dense city, with a radius that suits the cell size, this works well."}
]
},
{
"id": "edge",
"label": "Standing at a cell's edge",
"nodes": ["app2", "db2"],
"steps": [
{"el": "p2-u-app", "payload": "GET /nearby?lat=40.7370&lng=-73.9906&category=coffee", "set": {"req.user's cell": "dr5rsr", "req.cells read": "—", "req.rows read": "—", "req.results": "—"}, "text": "A user on East 17th Street is in cell dr5rsr, 33 metres south of its northern edge."},
{"el": "p2-app-db", "payload": "only dr5rsr?", "set": {"req.cells read": "1"}, "text": "Why read nine cells? Suppose the app server read only the user's own cell."},
{"el": "p2-db-app", "payload": "nearest coffee: 240 m", "ms": 5, "set": {"req.rows read": "1,400", "req.results": "nearest 240 m away · wrong"}, "text": "The nearest coffee in dr5rsr is 240 metres away. But there's a café 55 metres north, just across the edge, in cell dr5ru2. Those two codes share only dr5r: neighbours across some edges differ from the fifth character on. A search on the prefix dr5rs would miss it entirely."},
{"el": "p2-app-db", "payload": "dr5rsr + 8 neighbours", "set": {"req.cells read": "9"}, "text": "Reading the 8 neighbours too, which the app server works out from the cell's position rather than from its code, covers every direction."},
{"el": "p2-db-app", "payload": "nearest coffee: 55 m, in dr5ru2", "ms": 30, "set": {"req.rows read": "12,000", "req.results": "nearest 55 m away"}, "text": "Now the café 55 metres away is found. Nearby cells usually share a prefix, but not always, which is why a search reads the cell and its neighbours rather than a prefix."},
{"el": "p2-app-u", "payload": "café 55 m north first", "text": "Shown first."}
]
},
{
"id": "montana",
"label": "A road in eastern Montana",
"nodes": ["app2", "db2"],
"steps": [
{"el": "p2-u-app", "payload": "GET /nearby?lat=47.3208&lng=-106.9103&category=gas", "set": {"req.user's cell": "c87vpn", "req.cells read": "—", "req.rows read": "—", "req.results": "—"}, "text": "A driver on a road in eastern Montana asks for the nearest gas station, however far away it is."},
{"el": "p2-app-db", "payload": "9 cells at precision 6", "set": {"req.cells read": "9 × 6 chars · ~4 km²"}, "text": "The app server starts with 6-character cells, as in New York."},
{"el": "p2-db-app", "payload": "0 rows", "ms": 5, "set": {"req.rows read": "0"}, "text": "Nothing. There's no place of any kind in those 4 km²."},
{"el": "p2-app-db", "payload": "9 cells at precision 5", "set": {"req.cells read": "9 × 5 chars · ~150 km²"}, "text": "It tries again with 5-character cells, each 32 times bigger."},
{"el": "p2-db-app", "payload": "4 rows · no gas station", "ms": 5, "set": {"req.rows read": "4"}, "text": "Four places, none of them a gas station."},
{"el": "p2-app-db", "payload": "9 cells at precision 4", "set": {"req.cells read": "9 × 4 chars · ~4,600 km²"}, "text": "Once more, with 4-character cells, 20 km by 27 km each. There's no size in between: each step is 32 times the area of the last."},
{"el": "p2-db-app", "payload": "380 rows · 3 gas stations", "ms": 10, "set": {"req.rows read": "380", "req.results": "3 · nearest 24 km"}, "text": "Three gas stations, the nearest 24 km away. Three round trips to the database for one search."},
{"el": "p2-app-u", "payload": "nearest gas: 24 km", "text": "It works, slowly. And the same 4-character cells in New York would hold about 400,000 places each. Cells of one size suit either the city or the countryside, never both."}
]
}
]
}
</script>
<div class="diagram-caption">The app server encodes the user's position as a geohash, a short code for a cell of the map, and asks for the places in that cell and its eight neighbours. Places in one cell sit together in an ordinary index, so each cell is one short read.</div>
</div>

<div class="fail-hint">Click the app server or the database to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="app2">
<strong>If the app server fails:</strong> no searches and no edits until another server takes its traffic.
</div>
<div class="failure-impact is-hidden" data-component="db2">
<strong>If the database fails:</strong> nothing works. Every search still reads from it.
</div>
</div>

Geohash turns two dimensions into one sortable code, and a dense city search is now fast. Two problems remain. Every cell is the same size, so dense places hold thousands per cell and empty places need several widening searches. And every search, all 18,000 a second at peak, is still nine range reads on the database that also takes edits. Cells should be small where places are dense and large where they're sparse, and the search should run somewhere other than the database.

<!-- stage:3:3. A Quadtree in Memory -->

## Stage 3 — Cells Sized to the Data, in Memory

- **A location index service.** Separate servers hold every place's 64-byte summary in memory, in a tree. Searches go to them; the database is used only for details and edits.
- **The tree is a quadtree.** The root is the whole world. Any cell holding more than 100 places is split into four, and those are split again until each holds 100 or fewer. Around Union Square, leaves are about 230 by 150 metres; in eastern Montana they're about 50 by 40 km.
- **Search walks outwards, nearest cell first.** The server finds the leaf that holds the user, then visits leaves in order of how close their nearest edge is, checking each place in them. It stops when the next leaf's nearest edge is farther away than the 20th result found so far: nothing in it could be closer. One search, whatever the density.
- **Every server holds the whole world.** 13GB per server. Adding servers adds capacity; any server can answer any search.
- **The change stream keeps the index current.** Every committed change in the places database goes onto a stream, in order. Each index server applies it: an insert, a move, or a removal. A leaf that passes 100 places splits; one that drops below 25 merges back with its siblings.
- **A restart loads a snapshot, then catches up.** A nightly snapshot of the index, and the stream from the snapshot's position onwards ([Log-Based Systems](#/systems/log-based-systems)).
- **Details come from a cache.** The index returns IDs and distances. The API fetches names, addresses and photos for those 20 from a places cache in front of the database.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 350" width="860" height="350" role="img" aria-label="A phone asks the places API, which asks a location index service holding a quadtree in memory for the nearest places, then fetches their details from a places cache in front of the places database; edits go to the places database, whose changes flow through a change stream into the location index">
  <rect x="20" y="150" width="120" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="80" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Phone App</text>
  <text x="80" y="193" text-anchor="middle" class="d-label-muted" font-size="9">users and owners</text>
  <g data-fail-toggle="api3">
    <rect x="190" y="135" width="160" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="270" y="165" text-anchor="middle" class="d-actor-label" font-size="12">Places API</text>
    <text x="270" y="183" text-anchor="middle" class="d-label-muted" font-size="9">searches: index, then details</text>
    <text x="270" y="198" text-anchor="middle" class="d-label-muted" font-size="9">edits: database</text>
  </g>
  <g data-fail-toggle="idx3">
    <rect x="420" y="40" width="200" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="520" y="70" text-anchor="middle" class="d-actor-label" font-size="12">Location Index</text>
    <text x="520" y="88" text-anchor="middle" class="d-label-muted" font-size="9">whole-world quadtree in memory</text>
    <text x="520" y="103" text-anchor="middle" class="d-label-muted" font-size="9">≤ 100 places a leaf · 8 servers</text>
  </g>
  <g data-fail-toggle="str3">
    <rect x="690" y="40" width="150" height="100" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="78" text-anchor="middle" class="d-actor-label" font-size="12">Change Stream</text>
    <text x="765" y="96" text-anchor="middle" class="d-label-muted" font-size="9">every committed edit</text>
  </g>
  <g data-fail-toggle="cache3">
    <rect x="420" y="210" width="200" height="70" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="520" y="240" text-anchor="middle" class="d-actor-label" font-size="12">Places Cache</text>
    <text x="520" y="258" text-anchor="middle" class="d-label-muted" font-size="9">details by place_id</text>
  </g>
  <g data-fail-toggle="db3">
    <rect x="690" y="210" width="150" height="70" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="765" y="240" text-anchor="middle" class="d-actor-label" font-size="12">Places DB</text>
    <text x="765" y="258" text-anchor="middle" class="d-label-muted" font-size="9">source of truth</text>
  </g>
  <line id="p3-u-api" x1="142" y1="168" x2="186" y2="168" class="d-msg d-request" data-depends-on="api3" marker-end="url(#arrowP3)"></line>
  <line id="p3-api-u" x1="186" y1="196" x2="142" y2="196" class="d-msg d-response" data-depends-on="api3" marker-end="url(#arrowP3r)"></line>
  <line id="p3-api-idx" x1="352" y1="150" x2="416" y2="95" class="d-msg d-request" data-depends-on="api3 idx3" marker-end="url(#arrowP3)"></line>
  <line id="p3-idx-api" x1="416" y1="122" x2="352" y2="175" class="d-msg d-response" data-depends-on="api3 idx3" marker-end="url(#arrowP3r)"></line>
  <line id="p3-api-cache" x1="352" y1="198" x2="416" y2="232" class="d-msg d-request" data-depends-on="api3 cache3" marker-end="url(#arrowP3)"></line>
  <line id="p3-cache-api" x1="416" y1="258" x2="352" y2="220" class="d-msg d-response" data-depends-on="api3 cache3" marker-end="url(#arrowP3r)"></line>
  <line id="p3-cache-db" x1="622" y1="235" x2="686" y2="235" class="d-msg d-request" data-depends-on="cache3 db3" marker-end="url(#arrowP3)"></line>
  <line id="p3-db-cache" x1="686" y1="260" x2="622" y2="260" class="d-msg d-response" data-depends-on="cache3 db3" marker-end="url(#arrowP3r)"></line>
  <path id="p3-api-db" d="M270,227 L270,312 L765,312 L765,284" class="d-msg d-request" data-depends-on="api3 db3" marker-end="url(#arrowP3)"></path>
  <line id="p3-db-str" x1="765" y1="206" x2="765" y2="144" class="d-msg d-request" data-depends-on="db3 str3" marker-end="url(#arrowP3)"></line>
  <line id="p3-str-idx" x1="686" y1="90" x2="624" y2="90" class="d-msg d-request" data-depends-on="str3 idx3" marker-end="url(#arrowP3)"></line>
  <text x="430" y="342" text-anchor="middle" class="d-label-muted" font-size="10">play coffee near Union Square, then gas in eastern Montana, then a café opening</text>
  <defs>
    <marker id="arrowP3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP3r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "walk", "title": "Index walk", "rows": [["starting leaf", "—"], ["leaves visited", "—"], ["places checked", "—"], ["results", "—"]]},
{"id": "idx", "title": "Location index", "rows": [["applied up to", "12,004,118,550"], ["leaf by Union Sq", "100 places"]]}
],
"flows": [
{
"id": "coffee",
"label": "Coffee near Union Square",
"nodes": ["api3", "idx3", "cache3"],
"steps": [
{"el": "p3-u-api", "payload": "GET /nearby?lat=40.7359&lng=-73.9906&category=coffee&limit=20", "set": {"walk.starting leaf": "—", "walk.leaves visited": "—", "walk.places checked": "—", "walk.results": "—"}, "text": "The user in Union Square asks for the 20 nearest coffee places. No radius is needed now: the index will find the nearest, wherever they are, up to 50 km."},
{"el": "p3-api-idx", "payload": "nearest 20 coffee to 40.7359, -73.9906", "text": "The API asks any one of the eight location index servers. Each holds the whole world."},
{"el": "p3-idx-api", "payload": "20 place IDs + distances", "ms": 2, "set": {"walk.starting leaf": "depth 17 · 230 × 150 m · 96 places", "walk.leaves visited": "17", "walk.places checked": "1,400", "walk.results": "20 within 400 m"}, "text": "The server goes down the tree from the world to the leaf containing the user: 17 levels, each a quarter of the one above, ending at a leaf 230 by 150 metres. Then it visits leaves nearest-edge first, checking each place. After 17 leaves it has 20 coffee places, the farthest 400 metres away, and the next leaf's nearest edge is farther than that. It stops. 1,400 places checked, all in memory: 2ms."},
{"el": "p3-api-cache", "payload": "details for 20 IDs", "text": "The API asks the places cache for names, addresses, ratings and photos for those 20."},
{"el": "p3-cache-api", "payload": "20 details · all cached", "ms": 2, "text": "Popular places are always in the cache. A miss reads from the database and fills it."},
{"el": "p3-api-u", "payload": "20 coffee places, nearest first", "text": "One request to the index and one to the cache. The database wasn't touched."}
]
},
{
"id": "montana",
"label": "Gas in eastern Montana",
"nodes": ["api3", "idx3", "cache3"],
"steps": [
{"el": "p3-u-api", "payload": "GET /nearby?lat=47.3208&lng=-106.9103&category=gas", "set": {"walk.starting leaf": "—", "walk.leaves visited": "—", "walk.places checked": "—", "walk.results": "—"}, "text": "The driver in eastern Montana asks for the nearest gas station."},
{"el": "p3-api-idx", "payload": "nearest 20 gas to 47.3208, -106.9103", "text": "Same request, same tree."},
{"el": "p3-idx-api", "payload": "6 gas stations within 50 km", "ms": 1, "set": {"walk.starting leaf": "depth 9 · 53 × 39 km · 41 places", "walk.leaves visited": "7", "walk.places checked": "260", "walk.results": "6 within 50 km · nearest 24 km"}, "text": "Here the tree stopped splitting at depth 9: the leaf around the driver is 53 by 39 km and holds only 41 places. The walk visits 7 leaves, checks 260 places, and stops at the 50 km cap with 6 gas stations. In Stage 2 this took three round trips; here it's one, because the cells were sized by the data, not chosen in advance."},
{"el": "p3-api-cache", "payload": "details for 6 IDs", "text": "Details for six."},
{"el": "p3-cache-api", "payload": "4 cached · 2 read from the DB", "ms": 6, "text": "Rural places are looked up less often, so two weren't cached and were read from the database."},
{"el": "p3-api-u", "payload": "nearest gas: 24 km", "text": "The same search does the same amount of work in Manhattan and on the plains: about the cost of checking a few hundred to a few thousand places."}
]
},
{
"id": "open",
"label": "A café opens",
"nodes": ["api3", "db3", "str3", "idx3"],
"steps": [
{"el": "p3-u-api", "payload": "POST /places · Second Cup Roasters", "set": {"walk.starting leaf": "—", "walk.leaves visited": "—", "walk.places checked": "—", "walk.results": "—", "idx.applied up to": "12,004,118,550", "idx.leaf by Union Sq": "100 places"}, "text": "The owner adds the new café on East 16th Street, after it's been reviewed."},
{"el": "p3-api-db", "payload": "INSERT pl_90117 · version 1", "ms": 3, "text": "The API writes it to the places database, as in Stage 1. The database is still the only thing edits go to."},
{"el": "p3-db-str", "payload": "position 12,004,118,551 · upsert pl_90117", "text": "The change is read from the database's commit log and appended to the change stream. Every committed change appears, in commit order, and nothing that wasn't committed does."},
{"el": "p3-str-idx", "payload": "upsert pl_90117 · 40.7365, -73.9897", "ms": 2000, "set": {"idx.applied up to": "12,004,118,551", "idx.leaf by Union Sq": "101 → split into 4: 31 · 22 · 27 · 21"}, "text": "Every index server reads the stream and inserts the café into the leaf that covers its position. That leaf now has 101 places, so it splits into four smaller leaves. Each server records the stream position it has applied up to, about 2 seconds behind the database."},
{"el": "p3-u-api", "payload": "GET /nearby … category=coffee", "text": "A minute later, someone nearby searches for coffee."},
{"el": "p3-api-idx", "payload": "nearest 20 coffee", "text": "The index has the café."},
{"el": "p3-idx-api", "payload": "Second Cup Roasters · 110 m", "ms": 2, "set": {"walk.results": "20 · includes the new café"}, "text": "It's in the results, seconds after it was saved. The database took one insert; the 18,000 searches a second went to the index."},
{"el": "p3-api-u", "payload": "includes the new café", "text": "Shown."}
]
}
]
}
</script>
<div class="diagram-caption">A location index holds every place's summary in a quadtree in memory, with cells split until no leaf holds more than 100 places. Searches walk outwards from the user's leaf, nearest first. Edits go to the database, and its change stream keeps every index server current within seconds.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api3">
<strong>If an API server fails:</strong> the load balancer sends its requests to the others. They hold nothing of their own.
</div>
<div class="failure-impact is-hidden" data-component="idx3">
<strong>If a location index server fails:</strong> any other answers, since each holds the whole world. A replacement loads last night's snapshot, about a minute, then replays the stream from that point before it takes searches.
</div>
<div class="failure-impact is-hidden" data-component="str3">
<strong>If the change stream fails:</strong> searches keep working from the index as it is. New edits stop appearing until it's back, then all of them are applied in order.
</div>
<div class="failure-impact is-hidden" data-component="cache3">
<strong>If the places cache fails:</strong> details are read from the database. That's 20 reads per search, which the database can only take for a while; the API reads from its replicas and drops photos from results until the cache is back.
</div>
<div class="failure-impact is-hidden" data-component="db3">
<strong>If the places database fails:</strong> searches still work, from the index and the cache. Edits fail until it fails over to a replica.
</div>
</div>

Distance is now cheap to search, anywhere. But users don't search only by distance. A search for `vegan bakery` walks outwards checking every place's category, and in Manhattan only one place in five thousand is a vegan bakery, so finding a few means checking tens of thousands of places. In eastern Montana, where there are none, the walk checks everything out to the 50 km cap. And the nearest coffee isn't always the one people want: at 23:30, a 3.4-star café 90 metres away that closed at 22:00 is a bad first answer.

<!-- stage:4:4. Filters and Ranking -->

## Stage 4 — Skip What Doesn't Match, Rank What Does

- **Every tree node summarizes its categories.** Each node carries one bit per category, about 600 in all, set if any place below it has that category. 80 bytes per node, about 320MB in total. A walk for `vegan bakery` skips any node whose bit is off, without looking inside.
- **The summaries are kept current.** When a place is inserted, the bits along its path to the root are set. When one is removed, its leaf's bits are recomputed, then each parent's, as far up as anything changes.
- **The index returns candidates, not answers.** It returns the 200 nearest places that match the category and are inside the radius, each with its rating, review count and hours.
- **A ranker picks the 20.** It drops places that aren't open now, in the place's own time zone, and those below the minimum rating. Then it scores each one: the rating, pulled towards the average when there are few reviews, minus 0.8 for each kilometre of distance. The best 20 are returned.
- **Ratings arrive on the change stream.** When the reviews system updates a rating, it's written to the places database like any edit, and reaches the index in seconds.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 800 370" width="800" height="370" role="img" aria-label="A phone asks the places API, which asks a ranker; the ranker asks the location index, whose tree nodes carry category summaries, for candidates, and ranks them; the API fetches details from the places cache in front of the places database, whose changes flow through a change stream into the index">
  <rect x="20" y="150" width="110" height="60" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="176" text-anchor="middle" class="d-actor-label" font-size="12">Phone App</text>
  <text x="75" y="193" text-anchor="middle" class="d-label-muted" font-size="9">filters + position</text>
  <g data-fail-toggle="api4">
    <rect x="170" y="140" width="140" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="240" y="170" text-anchor="middle" class="d-actor-label" font-size="12">Places API</text>
    <text x="240" y="188" text-anchor="middle" class="d-label-muted" font-size="9">ranked IDs → details</text>
  </g>
  <g data-fail-toggle="rk4">
    <rect x="370" y="140" width="150" height="80" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="445" y="170" text-anchor="middle" class="d-actor-label" font-size="12">Ranker</text>
    <text x="445" y="188" text-anchor="middle" class="d-label-muted" font-size="9">open now · rating · distance</text>
    <text x="445" y="203" text-anchor="middle" class="d-label-muted" font-size="9">200 candidates → 20</text>
  </g>
  <g data-fail-toggle="idx4">
    <rect x="590" y="130" width="190" height="100" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="685" y="160" text-anchor="middle" class="d-actor-label" font-size="12">Location Index</text>
    <text x="685" y="178" text-anchor="middle" class="d-label-muted" font-size="9">quadtree in memory</text>
    <text x="685" y="193" text-anchor="middle" class="d-label-muted" font-size="9">category bits on every node</text>
  </g>
  <g data-fail-toggle="cache4">
    <rect x="170" y="270" width="140" height="60" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="240" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Places Cache</text>
    <text x="240" y="313" text-anchor="middle" class="d-label-muted" font-size="9">details by place_id</text>
  </g>
  <g data-fail-toggle="db4">
    <rect x="370" y="270" width="150" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="445" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Places DB</text>
    <text x="445" y="313" text-anchor="middle" class="d-label-muted" font-size="9">edits + ratings</text>
  </g>
  <g data-fail-toggle="str4">
    <rect x="590" y="270" width="190" height="60" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="685" y="296" text-anchor="middle" class="d-actor-label" font-size="12">Change Stream</text>
    <text x="685" y="313" text-anchor="middle" class="d-label-muted" font-size="9">every committed edit</text>
  </g>
  <line id="p4-u-api" x1="132" y1="168" x2="166" y2="168" class="d-msg d-request" data-depends-on="api4" marker-end="url(#arrowP4)"></line>
  <line id="p4-api-u" x1="166" y1="195" x2="132" y2="195" class="d-msg d-response" data-depends-on="api4" marker-end="url(#arrowP4r)"></line>
  <line id="p4-api-rk" x1="312" y1="168" x2="366" y2="168" class="d-msg d-request" data-depends-on="api4 rk4" marker-end="url(#arrowP4)"></line>
  <line id="p4-rk-api" x1="366" y1="195" x2="312" y2="195" class="d-msg d-response" data-depends-on="api4 rk4" marker-end="url(#arrowP4r)"></line>
  <line id="p4-rk-idx" x1="522" y1="168" x2="586" y2="168" class="d-msg d-request" data-depends-on="rk4 idx4" marker-end="url(#arrowP4)"></line>
  <line id="p4-idx-rk" x1="586" y1="195" x2="522" y2="195" class="d-msg d-response" data-depends-on="rk4 idx4" marker-end="url(#arrowP4r)"></line>
  <line id="p4-api-cache" x1="225" y1="222" x2="225" y2="266" class="d-msg d-request" data-depends-on="api4 cache4" marker-end="url(#arrowP4)"></line>
  <line id="p4-cache-api" x1="255" y1="266" x2="255" y2="222" class="d-msg d-response" data-depends-on="api4 cache4" marker-end="url(#arrowP4r)"></line>
  <line id="p4-cache-db" x1="312" y1="290" x2="366" y2="290" class="d-msg d-request" data-depends-on="cache4 db4" marker-end="url(#arrowP4)"></line>
  <line id="p4-db-cache" x1="366" y1="313" x2="312" y2="313" class="d-msg d-response" data-depends-on="cache4 db4" marker-end="url(#arrowP4r)"></line>
  <line id="p4-db-str" x1="522" y1="300" x2="586" y2="300" class="d-msg d-request" data-depends-on="db4 str4" marker-end="url(#arrowP4)"></line>
  <line id="p4-str-idx" x1="685" y1="268" x2="685" y2="234" class="d-msg d-request" data-depends-on="str4 idx4" marker-end="url(#arrowP4)"></line>
  <text x="400" y="362" text-anchor="middle" class="d-label-muted" font-size="10">play a rare category in Manhattan, then the best coffee at 23:30, then a rare category far from anywhere</text>
  <defs>
    <marker id="arrowP4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP4r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "walk", "title": "Index walk", "rows": [["nodes skipped", "—"], ["places checked", "—"], ["candidates", "—"]]},
{"id": "top", "title": "Ranked results", "rows": [["#1", "—"], ["#2", "—"], ["#3", "—"]]}
],
"flows": [
{
"id": "vegan",
"label": "Vegan bakery near Union Square",
"nodes": ["api4", "rk4", "idx4", "cache4"],
"steps": [
{"el": "p4-u-api", "payload": "GET /nearby … category=vegan_bakery&radius_m=3000", "set": {"walk.nodes skipped": "—", "walk.places checked": "—", "walk.candidates": "—", "top.#1": "—", "top.#2": "—", "top.#3": "—"}, "text": "The user in Union Square looks for a vegan bakery within 3 km."},
{"el": "p4-api-rk", "payload": "vegan_bakery · 3 km", "text": "The API passes the search to the ranker."},
{"el": "p4-rk-idx", "payload": "candidates: vegan_bakery within 3 km", "text": "The ranker asks the index for candidates. In Stage 3 the walk would check every place within 3 km, about 70,000, to find the few that match."},
{"el": "p4-idx-rk", "payload": "6 candidates", "ms": 1, "set": {"walk.nodes skipped": "~1,900 of ~1,920", "walk.places checked": "640", "walk.candidates": "6"}, "text": "Now, at each node, the walk checks the vegan bakery bit before going inside. Almost every node within 3 km has it off, so the walk skips them whole and goes down only the few paths that lead to a vegan bakery. 640 places checked, under a millisecond, 6 candidates."},
{"el": "p4-rk-api", "payload": "6 ranked", "set": {"top.#1": "Green Crumb · 1.1 km · 4.7★", "top.#2": "Plant Oven · 0.7 km · 4.2★", "top.#3": "Root Bakeshop · 2.4 km · 4.6★"}, "text": "The ranker scores the six. The closest isn't first: Green Crumb, 1.1 km away with 4.7 stars from 900 reviews, scores higher than Plant Oven, 0.7 km away with 4.2."},
{"el": "p4-api-cache", "payload": "details for 6 IDs", "text": "Details from the cache."},
{"el": "p4-cache-api", "payload": "6 details", "ms": 2, "text": "All cached."},
{"el": "p4-api-u", "payload": "6 vegan bakeries, best first", "text": "Rare categories now cost about the same as common ones. The summaries are what let the tree be searched by category and position together."}
]
},
{
"id": "best",
"label": "The best coffee at 23:30",
"nodes": ["api4", "rk4", "idx4", "cache4"],
"steps": [
{"el": "p4-u-api", "payload": "GET /nearby … category=coffee&open_now=true&radius_m=1500", "set": {"walk.nodes skipped": "—", "walk.places checked": "—", "walk.candidates": "—", "top.#1": "—", "top.#2": "—", "top.#3": "—"}, "text": "At 23:30 on a Friday, the user in Union Square asks for coffee that's open now, within 1.5 km."},
{"el": "p4-api-rk", "payload": "coffee · open now · 1.5 km", "text": "The API passes it to the ranker."},
{"el": "p4-rk-idx", "payload": "200 nearest coffee within 1.5 km", "text": "The ranker asks for the 200 nearest coffee places, more than it needs, because it's going to throw many away."},
{"el": "p4-idx-rk", "payload": "200 candidates · rating, reviews, hours", "ms": 3, "set": {"walk.nodes skipped": "~60%", "walk.places checked": "11,000", "walk.candidates": "200"}, "text": "Each candidate comes with what the ranker needs from its 64-byte entry: rating, review count and opening hours. Nothing has to be looked up elsewhere."},
{"el": "p4-rk-api", "payload": "23 open → ranked → 20", "ms": 1, "set": {"top.#1": "Night Owl Coffee · 380 m · 4.7★ · 2,100", "top.#2": "Corner Espresso · 120 m · 4.1★ · 300", "top.#3": "Late Pour · 610 m · 4.5★ · 1,400"}, "text": "177 of the 200 are closed at 23:30 New York time, including the 3.4-star café 90 metres away. The ranker scores the 23 that are open: rating minus 0.8 a kilometre. Night Owl, 380 metres away at 4.7 stars, scores 4.38 and comes first. A new place with 5.0 stars from 3 reviews is pulled towards the 3.8 average and counts as 3.9, so a few friends' reviews can't put it on top."},
{"el": "p4-api-cache", "payload": "details for 20 IDs", "text": "Details for the 20."},
{"el": "p4-cache-api", "payload": "20 details", "ms": 2, "text": "From the cache."},
{"el": "p4-api-u", "payload": "20 open coffee places, best first", "text": "Filtering and ranking happen on 200 small entries in memory, after the index has done the geometry."}
]
},
{
"id": "nowhere",
"label": "A rare category far from anywhere",
"nodes": ["api4", "rk4", "idx4"],
"steps": [
{"el": "p4-u-api", "payload": "GET /nearby?lat=47.3208&lng=-106.9103&category=ev_charger", "set": {"walk.nodes skipped": "—", "walk.places checked": "—", "walk.candidates": "—", "top.#1": "—", "top.#2": "—", "top.#3": "—"}, "text": "The driver in eastern Montana looks for an EV charger."},
{"el": "p4-api-rk", "payload": "ev_charger · 50 km", "text": "No radius given, so the 50 km cap applies."},
{"el": "p4-rk-idx", "payload": "candidates: ev_charger within 50 km", "text": "In Stage 3, this would check every place within 50 km before giving up."},
{"el": "p4-idx-rk", "payload": "0 candidates", "ms": 1, "set": {"walk.nodes skipped": "all 4 nodes in reach", "walk.places checked": "0", "walk.candidates": "0"}, "text": "The large nodes that cover the 50 km around the driver all have the ev charger bit off. The walk skips them without opening a single leaf, and stops: there's nothing to find."},
{"el": "p4-rk-api", "payload": "none within 50 km", "set": {"top.#1": "(none within 50 km)"}, "text": "An empty result."},
{"el": "p4-api-u", "payload": "200 · no EV chargers within 50 km", "text": "The phone offers to search along the route instead. The service has answered in a millisecond, and the cheapest searches are now the ones with nothing to find."}
]
}
]
}
</script>
<div class="diagram-caption">Every node in the quadtree records which categories exist below it, so a walk skips whole areas with nothing that matches. The index returns 200 candidates with their ratings and hours; a ranker drops those that are closed or poorly rated and orders the rest by rating and distance.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="api4">
<strong>If an API server fails:</strong> the others take its requests.
</div>
<div class="failure-impact is-hidden" data-component="rk4">
<strong>If a ranker fails:</strong> the API sends to another. If every ranker is down, the API asks the index directly and returns the nearest matches unranked, with closed places still filtered out by the index's hours.
</div>
<div class="failure-impact is-hidden" data-component="idx4">
<strong>If a location index server fails:</strong> rankers use another. A replacement loads the snapshot, with its category summaries, then replays the stream.
</div>
<div class="failure-impact is-hidden" data-component="cache4">
<strong>If the places cache fails:</strong> details are read from database replicas, slower, with photos dropped until it's back.
</div>
<div class="failure-impact is-hidden" data-component="db4">
<strong>If the places database fails:</strong> searches keep working. Edits and rating updates wait until it fails over.
</div>
<div class="failure-impact is-hidden" data-component="str4">
<strong>If the change stream fails:</strong> the index stops changing. Searches work, with edits and ratings frozen until it's back.
</div>
</div>

Each search is now a few milliseconds of work, and the answers are good. But all of it runs in one region, in Virginia. A user in Tokyo waits 160ms each way before any work starts. On New Year's Eve, a million people stand in a few blocks around Times Square and thousands a minute ask for exactly the same thing, each answer worked out from scratch. And the map is the worst case: every small pan asks for "everything on screen", a rectangle no other phone will ever ask for again.

<!-- stage:5:5. Regions, Shared Answers, Tiles -->

## Stage 5 — Copies Everywhere, Answers Shared

- **Three regions, each with the whole world.** Virginia, Frankfurt and Singapore each run the API, rankers and index servers. The index is 13GB, so every region holds all of it rather than dividing the world between them. Any region can answer any search ([Multi-Region & Disaster Recovery](#/systems/multi-region-dr)).
- **One database, its stream copied to every region.** Edits still go to the places database in Virginia. Its change stream is copied to the other two regions, where the index servers apply it, a few seconds behind.
- **Nearby users share an answer.** The API rounds the user's position to a 7-character geohash, a cell about 150 by 115 metres, and caches results by that cell, the category, the filters and the radius for 5 minutes. The phone recomputes distances from its exact position.
- **The map asks for tiles.** The visible map is made of fixed squares, named by zoom, column and row. The app asks for the coffee pins in each tile. A tile is the same for everyone, so the CDN caches it for 5 minutes ([CDN & Edge Delivery](#/systems/cdn-edge-delivery)). Each tile carries at most 30 pins, the best-ranked in it.
- **Closures are taken back at once.** The stream reader in each region keeps a small set of places removed in the last 10 minutes. The API filters every cached answer against it, and the CDN tiles containing a closed place are purged.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 860 400" width="860" height="400" role="img" aria-label="A phone asks a CDN edge for map tiles and the places API in the nearest region for lists; inside each of three regions, the API checks a results cache keyed by a small cell, then asks the ranker and location index, which hold the whole world; a change stream copied to every region updates the index and tells the API which places were just removed">
  <rect x="365" y="20" width="480" height="345" rx="10" class="d-axis" fill="none" stroke-dasharray="5 4"></rect>
  <text x="605" y="356" text-anchor="middle" class="d-label-muted" font-size="9">one region of three · Virginia, Frankfurt, Singapore · each holds the whole world</text>
  <rect x="20" y="170" width="110" height="70" rx="6" class="d-actor-box" data-role="client"></rect>
  <text x="75" y="198" text-anchor="middle" class="d-actor-label" font-size="12">Phone App</text>
  <text x="75" y="215" text-anchor="middle" class="d-label-muted" font-size="9">map + list</text>
  <g data-fail-toggle="cdn5">
    <rect x="170" y="40" width="150" height="70" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="245" y="68" text-anchor="middle" class="d-actor-label" font-size="12">CDN Edge</text>
    <text x="245" y="85" text-anchor="middle" class="d-label-muted" font-size="9">map tiles · 5 min</text>
  </g>
  <g data-fail-toggle="str5">
    <rect x="620" y="40" width="200" height="64" rx="6" class="d-actor-box" data-role="datastore"></rect>
    <text x="720" y="67" text-anchor="middle" class="d-actor-label" font-size="12">Change Stream</text>
    <text x="720" y="84" text-anchor="middle" class="d-label-muted" font-size="9">copied from Virginia</text>
  </g>
  <g data-fail-toggle="api5">
    <rect x="400" y="160" width="150" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="475" y="190" text-anchor="middle" class="d-actor-label" font-size="12">Places API</text>
    <text x="475" y="208" text-anchor="middle" class="d-label-muted" font-size="9">rounds to a 150 m cell</text>
    <text x="475" y="223" text-anchor="middle" class="d-label-muted" font-size="9">drops just-closed places</text>
  </g>
  <g data-fail-toggle="idx5">
    <rect x="620" y="160" width="200" height="90" rx="6" class="d-actor-box" data-role="compute"></rect>
    <text x="720" y="190" text-anchor="middle" class="d-actor-label" font-size="12">Ranker + Location Index</text>
    <text x="720" y="208" text-anchor="middle" class="d-label-muted" font-size="9">the whole world in memory</text>
  </g>
  <g data-fail-toggle="rc5">
    <rect x="400" y="285" width="150" height="56" rx="6" class="d-actor-box" data-role="cache"></rect>
    <text x="475" y="309" text-anchor="middle" class="d-actor-label" font-size="12">Results Cache</text>
    <text x="475" y="326" text-anchor="middle" class="d-label-muted" font-size="9">cell + query · 5 min</text>
  </g>
  <line id="p5-u-cdn" x1="75" y1="168" x2="180" y2="113" class="d-msg d-request" data-depends-on="cdn5" marker-end="url(#arrowP5)"></line>
  <line id="p5-cdn-u" x1="205" y1="113" x2="100" y2="168" class="d-msg d-response" data-depends-on="cdn5" marker-end="url(#arrowP5r)"></line>
  <line id="p5-cdn-api" x1="322" y1="92" x2="425" y2="156" class="d-msg d-request" data-depends-on="cdn5 api5" marker-end="url(#arrowP5)"></line>
  <line id="p5-api-cdn" x1="448" y1="156" x2="322" y2="72" class="d-msg d-response" data-depends-on="cdn5 api5" marker-end="url(#arrowP5r)"></line>
  <line id="p5-u-api" x1="132" y1="195" x2="396" y2="195" class="d-msg d-request" data-depends-on="api5" marker-end="url(#arrowP5)"></line>
  <line id="p5-api-u" x1="396" y1="225" x2="132" y2="225" class="d-msg d-response" data-depends-on="api5" marker-end="url(#arrowP5r)"></line>
  <line id="p5-api-idx" x1="552" y1="190" x2="616" y2="190" class="d-msg d-request" data-depends-on="api5 idx5" marker-end="url(#arrowP5)"></line>
  <line id="p5-idx-api" x1="616" y1="222" x2="552" y2="222" class="d-msg d-response" data-depends-on="api5 idx5" marker-end="url(#arrowP5r)"></line>
  <line id="p5-api-rc" x1="460" y1="252" x2="460" y2="281" class="d-msg d-request" data-depends-on="api5 rc5" marker-end="url(#arrowP5)"></line>
  <line id="p5-rc-api" x1="490" y1="281" x2="490" y2="252" class="d-msg d-response" data-depends-on="api5 rc5" marker-end="url(#arrowP5r)"></line>
  <line id="p5-str-idx" x1="720" y1="106" x2="720" y2="156" class="d-msg d-request" data-depends-on="str5 idx5" marker-end="url(#arrowP5)"></line>
  <path id="p5-str-api" d="M618,72 L520,72 L520,156" class="d-msg d-request" data-depends-on="str5 api5" marker-end="url(#arrowP5)"></path>
  <text x="430" y="392" text-anchor="middle" class="d-label-muted" font-size="10">play New Year's Eve in Times Square, then panning the map, then a café closing for good</text>
  <defs>
    <marker id="arrowP5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
    <marker id="arrowP5r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-response"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "req", "title": "This request", "rows": [["key", "—"], ["answered by", "—"]]},
{"id": "rc", "title": "Shared answer", "rows": [["computed", "—"], ["served since", "—"]]}
],
"flows": [
{
"id": "nye",
"label": "New Year's Eve in Times Square",
"nodes": ["api5", "rc5", "idx5"],
"steps": [
{"el": "p5-u-api", "payload": "GET /nearby?lat=40.7580&lng=-73.9855&category=coffee&open_now=true", "set": {"req.key": "—", "req.answered by": "—", "rc.computed": "—", "rc.served since": "—"}, "text": "23:10 on New Year's Eve. About a million people are packed into the blocks around Times Square, and thousands a minute ask for coffee nearby. The first to ask from one corner sends this."},
{"el": "p5-api-rc", "payload": "get dr5ru7v · coffee · open_now · 1500", "set": {"req.key": "dr5ru7v · coffee · open_now"}, "text": "The API rounds the position to its 7-character geohash cell, dr5ru7v, about 150 by 115 metres, and looks up that cell, category and filters in the results cache."},
{"el": "p5-rc-api", "payload": "miss", "ms": 1, "text": "Nobody in this cell has asked in the last 5 minutes."},
{"el": "p5-api-idx", "payload": "coffee · open now · from the cell's centre", "text": "The API asks the ranker, which asks the index, as in Stage 4, using the centre of the cell as the starting point."},
{"el": "p5-idx-api", "payload": "20 ranked", "ms": 4, "set": {"req.answered by": "ranker + index", "rc.computed": "23:10:04"}, "text": "20 ranked coffee places, each with its position."},
{"el": "p5-api-rc", "payload": "set · TTL 5 min", "text": "The API stores the answer under the cell's key for 5 minutes."},
{"el": "p5-api-u", "payload": "20 coffee places · with positions", "text": "The phone recomputes each distance from its own exact position and re-sorts if needed. Within 150 metres, the order barely changes."},
{"el": "p5-u-api", "payload": "the next 2,300 people in dr5ru7v", "text": "Over the next 5 minutes, 2,300 more people in the same cell ask the same question."},
{"el": "p5-api-rc", "payload": "get dr5ru7v · coffee · open_now · 1500", "text": "Same cell, same key."},
{"el": "p5-rc-api", "payload": "hit", "ms": 1, "set": {"req.answered by": "results cache", "rc.served since": "2,300 times"}, "text": "Every one of them is answered from the cache. The ranker and index worked once for this corner of Times Square, not 2,300 times. Across the world, about 45% of list searches are answered this way, most of them in the busiest places at the busiest times."},
{"el": "p5-api-u", "payload": "20 coffee places", "text": "The busier a spot gets, the more people share each answer. The crowd that would have been a hot spot is what makes the cache work."}
]
},
{
"id": "pan",
"label": "Panning the map",
"nodes": ["cdn5", "api5", "idx5"],
"steps": [
{"el": "p5-u-cdn", "payload": "8 tiles · coffee/16/19298/24634 …", "set": {"req.key": "coffee/16/19298/24634", "req.answered by": "—", "rc.computed": "—", "rc.served since": "—"}, "text": "A user opens the map at Union Square, zoomed in to street level, zoom 16. Each tile here is a square about 460 metres across, and the screen covers 2 across by 4 down. The app asks the CDN for the coffee pins in each of the 8."},
{"el": "p5-cdn-api", "payload": "7 cached · miss: coffee/16/19299/24636", "text": "Seven are cached at the edge; people look at Union Square all day. One isn't."},
{"el": "p5-api-idx", "payload": "best 30 coffee inside the tile", "text": "The API asks the index for coffee places inside that square, ranked, at most 30. A tile holds a fixed number of pins so busy areas don't vanish under them; at zoom 13, where a tile is 3.7 km across, the same 30 slots go to the best places in a much bigger area."},
{"el": "p5-idx-api", "payload": "24 pins", "ms": 3, "text": "24 coffee places in that tile."},
{"el": "p5-api-cdn", "payload": "pins · max-age 300", "set": {"req.answered by": "CDN · 7 of 8"}, "text": "The API returns the tile, cacheable for 5 minutes. The edge keeps it for the next person."},
{"el": "p5-cdn-u", "payload": "8 tiles", "ms": 15, "text": "The map fills in."},
{"el": "p5-u-cdn", "payload": "pan east · 4 new tiles", "set": {"req.key": "coffee/16/19300/24633 …"}, "text": "The user drags the map one tile to the east. The 4 tiles still on screen are already on the phone. Only the new column of 4 is requested."},
{"el": "p5-cdn-u", "payload": "4 tiles · all cached", "ms": 15, "set": {"req.answered by": "CDN · 4 of 4"}, "text": "All four come from the edge. Asking for 'what's in my viewport' would have been a new question for the servers on every drag. Asking for named squares makes every drag a question someone has already asked. About 90% of tile loads never leave the CDN."}
]
},
{
"id": "close",
"label": "A café closes for good",
"nodes": ["str5", "idx5", "api5", "rc5"],
"steps": [
{"el": "p5-str-idx", "payload": "remove pl_51870 · closed permanently", "ms": 3000, "set": {"req.key": "—", "req.answered by": "—", "rc.computed": "23:07 · includes pl_51870", "rc.served since": "—"}, "text": "An editor marks a café near Union Square as closed for good. The change is committed in Virginia and reaches each region's copy of the stream within a few seconds. The index servers remove it."},
{"el": "p5-str-api", "payload": "recently removed: pl_51870", "text": "Cached answers around it still include it, and could for up to 5 minutes, sending someone to a locked door. So the stream reader in each region also adds it to the recently removed set held by every API server. The CDN tiles that contain it, one per zoom level, are purged."},
{"el": "p5-u-api", "payload": "GET /nearby … coffee near Union Square", "text": "Someone in the café's cell searches for coffee."},
{"el": "p5-api-rc", "payload": "get dr5rsr9 · coffee", "text": "The API looks up the cell's cached answer."},
{"el": "p5-rc-api", "payload": "hit · computed 23:07 · includes pl_51870", "ms": 1, "text": "There is one, computed three minutes ago, and it includes the closed café."},
{"el": "p5-api-u", "payload": "19 places · pl_51870 dropped", "set": {"req.answered by": "results cache, filtered"}, "text": "Before returning it, the API drops any place in the recently removed set. The user never sees the closed café, without anyone having to find every cached answer that mentioned it. Ordinary edits, such as new opening hours, are allowed to wait out the 5 minutes."}
]
}
]
}
</script>
<div class="diagram-caption">Every region holds the whole index and answers the users nearest it. List searches from the same 150-metre cell share one cached answer for 5 minutes, and the map asks for fixed tiles that the CDN shares between everyone. A change stream copied to each region updates the index and removes closed places from cached answers.</div>
</div>

<div class="fail-hint">Click any component to see what happens if it fails.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="cdn5">
<strong>If a CDN edge fails:</strong> phones are sent to the next nearest edge. If the CDN fails everywhere, tile requests reach the API, about ten times the usual load, and the API serves tiles at lower zoom levels first while it scales up.
</div>
<div class="failure-impact is-hidden" data-component="str5">
<strong>If a region's change stream copy falls behind:</strong> that region's index is a little stale. Searches still work. An alert fires after a minute's lag, and if it can't catch up the region is taken out of rotation so its users get current answers from another.
</div>
<div class="failure-impact is-hidden" data-component="api5">
<strong>If a region's API fails, or the whole region:</strong> phones are sent to the next nearest region. Every region holds the whole world, so it can answer any search, just from farther away.
</div>
<div class="failure-impact is-hidden" data-component="idx5">
<strong>If an index server fails:</strong> the others in the region take its searches. The region keeps enough spare servers to lose two at peak.
</div>
<div class="failure-impact is-hidden" data-component="rc5">
<strong>If the results cache fails:</strong> every list search goes to the ranker and index, about twice the usual load. The region is sized to carry that, with less spare.
</div>
</div>

This is the full design. Places live in one relational database, which takes every edit and checks the version it was based on. A change stream carries every committed change to location index servers in three regions, each holding the whole world's places in a quadtree in memory, with cells split until none holds more than 100, so cells are small in cities and large in empty country. A search walks outwards from the user's leaf, nearest first, skipping any part of the tree whose category summary says nothing there matches, and stops when nothing farther could be closer. A ranker filters the candidates by opening hours and rating and orders them by rating and distance. Nearby users share an answer cached by a 150-metre cell, and the map is built from fixed tiles that the CDN shares between everyone. Places that close are removed from cached answers within seconds.

<!-- tab:deep-dives:Deep Dives -->

## Deep Dives

Optional: each of these expands on one hard sub-problem from the Architecture tab.

### Ways to index location

| Approach | How it finds nearby places | Trade-off |
|---|---|---|
| Index on latitude (and longitude) | A strip around the world, then filter | Simple. Reads far more than it returns |
| Geohash | Fixed cells with sortable codes; read the cell and its 8 neighbours | Works in any database. One cell size doesn't suit both dense and sparse areas |
| Quadtree (this design) | Cells split until each holds at most 100 places | Adapts to density. Lives in memory, kept current by applying changes |
| Hilbert curve cells | Fixed cells numbered along a curve that keeps neighbours close; read a few numbered ranges | Fewer jumps at edges than geohash. Still one size per level |
| Hexagon grids | Fixed hexagons, all six neighbours the same distance away | Good for counting and smoothing over areas. Hexagons don't nest exactly |
| R-tree (database spatial index) | Boxes around groups of places, nested | Built into spatial databases. Updates and very high read rates are harder to scale |

The common idea is the same throughout: turn two dimensions into something an index can search, accept that cells have edges, and always look past them.

### How a geohash is built

Start with the whole world. Split it by longitude: west of 0° is 0, east is 1. Split the half you're in by latitude: south is 0, north is 1. Keep alternating. Union Square, at -73.99°, is west of 0°, so the first bit is 0; it's north of the equator, so the second is 1; it's east of -90°, so the third is 1, and so on. Every 5 bits become one character from a 32-character alphabet, so 6 characters are 30 bits: 15 halvings of longitude and 15 of latitude. The result is a code where each extra character is a smaller cell inside the last one.

<div class="diagram-wrap">
<svg viewBox="0 0 520 260" width="520" height="260" role="img" aria-label="A three by three grid of six-character geohash cells around Union Square: the top row is dr5ru0, dr5ru2, dr5ru8; the middle row is dr5rsp, dr5rsr, dr5rsx; the bottom row is dr5rsn, dr5rsq, dr5rsw">
  <rect x="110" y="20" width="100" height="66" class="d-note"></rect>
  <rect x="210" y="20" width="100" height="66" class="d-note"></rect>
  <rect x="310" y="20" width="100" height="66" class="d-note"></rect>
  <rect x="110" y="86" width="100" height="66" class="d-note"></rect>
  <rect x="210" y="86" width="100" height="66" class="d-actor-box" data-role="routing"></rect>
  <rect x="310" y="86" width="100" height="66" class="d-note"></rect>
  <rect x="110" y="152" width="100" height="66" class="d-note"></rect>
  <rect x="210" y="152" width="100" height="66" class="d-note"></rect>
  <rect x="310" y="152" width="100" height="66" class="d-note"></rect>
  <line x1="110" y1="86" x2="410" y2="86" class="d-axis"></line>
  <line x1="110" y1="152" x2="410" y2="152" class="d-axis"></line>
  <line x1="210" y1="20" x2="210" y2="218" class="d-axis"></line>
  <line x1="310" y1="20" x2="310" y2="218" class="d-axis"></line>
  <text x="160" y="58" text-anchor="middle" class="d-note-text">dr5ru0</text>
  <text x="260" y="58" text-anchor="middle" class="d-note-text">dr5ru2</text>
  <text x="360" y="58" text-anchor="middle" class="d-note-text">dr5ru8</text>
  <text x="160" y="124" text-anchor="middle" class="d-note-text">dr5rsp</text>
  <text x="260" y="117" text-anchor="middle" class="d-actor-label" font-size="12">dr5rsr</text>
  <text x="260" y="134" text-anchor="middle" class="d-label-muted" font-size="9">Union Square</text>
  <text x="360" y="124" text-anchor="middle" class="d-note-text">dr5rsx</text>
  <text x="160" y="190" text-anchor="middle" class="d-note-text">dr5rsn</text>
  <text x="260" y="190" text-anchor="middle" class="d-note-text">dr5rsq</text>
  <text x="360" y="190" text-anchor="middle" class="d-note-text">dr5rsw</text>
  <text x="260" y="244" text-anchor="middle" class="d-label-muted" font-size="10">each cell ~610 m tall × 930 m wide · the row above shares only "dr5r"</text>
</svg>
<div class="diagram-caption">The nine cells a Stage 2 search reads around Union Square. Cells side by side in the middle and bottom rows share five characters; across the northern edge, the codes differ from the fifth character on, because that edge is where a much earlier halving of latitude fell.</div>
</div>

That's why a search reads neighbours by position, not by prefix. Neighbours are worked out by shifting the cell's latitude and longitude bits by one step and re-encoding, which also handles the date line, where longitude wraps from 180° to -180°.

### The nearest-first walk

```
heap = [(0, root)]                          -- ordered by distance to the user
results = []                                -- best k so far, by distance
while heap is not empty:
    d, node = pop nearest
    if len(results) == k and d > farthest(results): stop
    if d > radius: stop
    if node does not have the category bit: continue
    if node is a leaf:
        for place in node: if it matches, keep it among the k nearest
    else:
        for child in node.children: push (distance to child's nearest edge, child)
```

The distance to a node is the distance from the user to the nearest point of its rectangle, zero if the user is inside it. Because nodes come off the heap in that order, once the next node is farther than the k-th result, no place in it or in anything still on the heap can be closer. The walk is correct however the tree is shaped, and cheap because it rarely opens more than a few dozen leaves.

### Distance on a sphere

Exact great-circle distance (the haversine formula) needs several trigonometric calls. Within 50 km a flat approximation is accurate to well under 1%: scale the longitude difference by the cosine of the latitude, then use Pythagoras. The index uses the flat version for every comparison during the walk and computes the exact distance only for the results it returns. Near the poles, where a degree of longitude is tiny, and across the date line, where 179.9° and -179.9° are 20 km apart, the walk works in wrapped longitude so neighbours are found on both sides.

### Changing the tree while it's read

Thousands of searches a second walk the tree while changes from the stream modify it. Each leaf is small, so a change copies the leaf, edits the copy and swaps the parent's pointer to it in one step. A walk in progress sees either the old leaf or the new one, never half of each. A split builds the four new leaves completely before swapping them in. Category bits are updated from the leaf upwards after the swap, so for a moment a parent may say a category exists below it when it no longer does; that costs a wasted look, never a missed result. Only one writer per server applies the stream, so changes never race each other.

### Ranking

Score = adjusted rating − 0.8 × distance in km. The adjusted rating is (reviews × rating + 50 × 3.8) ÷ (reviews + 50): each place is treated as if it had 50 extra reviews at the average rating, so a few reviews can only move it a little. The weights are tuned on what people actually pick: a weight that's too high on distance shows the nearest mediocre place first; too low and people are sent across town. The ranker can add signals without touching the index, such as how often a place is picked from searches like this one, because it only ever looks at 200 candidates.

### Replicating instead of sharding

The whole index is 13GB, so each region holds all of it and capacity grows by adding servers. Splitting the world between servers by area would bring three problems: busy areas make busy shards (Manhattan at lunch, Times Square on New Year's Eve), searches near a shard's edge need two shards, and sparse areas need shards covering huge regions to hold enough to be worth a server. It becomes necessary when the index no longer fits on one server, say with billions of places or with large per-place data such as full text. Then the cells are numbered along a Hilbert curve, split into ranges of about equal traffic rather than equal area, and each range is held by several servers ([Partitioning & Sharding](#/systems/partitioning-sharding)).

<!-- tab:bottlenecks-tradeoffs:Bottlenecks & Trade-offs -->

## Bottlenecks & Trade-offs

### Shared answers against exact answers

Caching by a 150-metre cell means everyone in the cell gets the answer computed for its centre. The phone corrects distances, but a place just past the radius from the centre and just inside it from the user can be missing. Smaller cells are more exact and share less. 150 metres keeps the error to a block and still lets crowds share answers.

### Staleness from caches

Cached results and tiles can be 5 minutes old. New opening hours or a better rating wait out that time. Closures are filtered at once because they're the stale answer that hurts most. Shorter caching would mean fresher answers and more work for the index on exactly the busiest occasions.

### Tiles hide places

A tile shows at most 30 pins. When zoomed out over a dense city, most places aren't on the map until the user zooms in, and the 30 chosen depend on the ranking. Showing more pins makes the map unreadable; clustering them into counts is the usual alternative, at the cost of a less useful zoomed-out view.

### Memory sets the limit

Every index server holds every place. That's what keeps searches simple and regions independent, and it means the per-place summary has to stay small. Adding a field to every place costs 200 million times its size, on every server in every region. Data that only the ranker needs for a few candidates is better fetched for those candidates than stored in the index.

### One database for every edit

All edits go to one database in Virginia. At 25 a second that's comfortable, and it keeps edits simple and conflicts easy to catch. Edits from Singapore pay a round trip, and if Virginia fails, edits pause until the database fails over, while searches everywhere carry on.

### Straight lines, not travel time

A café 300 metres away across a river with no bridge is not 300 metres away. Ranking by travel time needs a routing system and is much more expensive per candidate, so it's done only for the top few results, if at all.

<!-- tab:security:Security & Abuse Prevention -->

## Security & Abuse Prevention

Being shown near the top of a nearby search is worth real money to a business, so the listings and the ratings are what attackers go after. The searches carry the user's location, which is what needs protecting on the other side ([Security & Authentication](#/systems/security-authentication)).

### Fake and duplicate listings

Fake listings, such as a locksmith or a repair service registered at dozens of addresses it doesn't occupy, crowd out real ones and can lead to scams. New places start as `pending_review` and aren't indexed until checked. A business verifies its address by a code sent by post or a call to its listed number. Places with very similar names within a few hundred metres are flagged as likely duplicates, and an account creating many listings is limited and reviewed.

### Attacks on competitors

A malicious edit can move a rival's pin into a river, change its hours, or mark it closed. Edits from anyone other than a verified owner go to review before they change the listing; a closure needs confirmation from several sources or the owner. Every edit is versioned, so a bad one is reverted to the previous version in one step, and accounts whose edits are often reverted lose the ability to edit.

### Fake reviews

The rating in the index comes from reviews that have passed the reviews system's fraud checks. The adjustment towards the average means a handful of reviews moves a place only a little, so buying a few reviews isn't enough to reach the top.

### Location privacy

A user's position reveals where they live, work and spend their nights. The service uses it for the search and doesn't store it: logs keep only a 6-character geohash, about 600 metres across, and are deleted after 30 days. Cache keys contain a cell, never a user. Places that would endanger people if their location were public, such as shelters for people fleeing violence, are never listed.

### Scraping

Walking every tile at every zoom would copy the whole listing database. Tiles carry only IDs, positions and ratings, rate limits apply per client and per IP at the edge, and requests for tiles in patterns no person browses, such as a grid sweep across a country, are slowed and then blocked ([Rate Limiting](#/systems/rate-limiting)).

<!-- tab:monitoring:Monitoring & Operations -->

## Monitoring & Operations

### What to track

- **Latency**: API time at p50 and p99, and index walk time, per region and per category.
- **Index lag**: for every index server, how far its applied stream position is behind the database, in seconds.
- **Index agreement**: the number of places in each top-level cell, compared across all servers. Servers that agree on the stream position should agree exactly.
- **Caches**: results cache hit rate per region, CDN hit rate for tiles, and the size of the recently removed set.
- **Results**: the share of searches returning nothing, by region and category, and how often users pick a result.
- **The tree**: depth, the largest leaf, and memory headroom on each server.

([Observability](#/systems/observability))

### What to alert on

- Any index server more than **60 seconds** behind the database.
- Two servers at the same stream position disagreeing on any cell's count: one has applied a change wrongly.
- API p99 above **100ms**, or index walk p99 above **10ms**, in any region.
- The share of empty results rising by more than **5 points** in any country: a region's index may be missing data.
- Results cache or CDN hit rate dropping by more than **15 points**.
- Memory headroom on index servers below **25%**.

### "A new place doesn't show up" — what happens?

Find it in the places database: if it's still `pending_review`, it hasn't been approved. If it's approved, find its change on the stream and check every index server's applied position against it. If they're past it but the place is missing, look at its stored position, a swapped latitude and longitude puts a New York café in Antarctica. If the index has it, the user may be seeing a cached answer or tile up to 5 minutes old.

### "Searches are slow in one city" — what happens?

Compare that city's walk times and places checked with others. A rise in places checked with no change in traffic points at a leaf that isn't splitting, or a burst of listings in one spot, often fake. Normal walk times with a low results cache hit rate points at the cache. If everything in the region is slow, check whether users are being sent to a distant region because their own is out of rotation.

### "Results are wrong in one region" — what happens?

Compare that region's stream position with the others. If its stream copy is stuck, the region is answering from an old index: take it out of rotation so users go to another region, then fix the copy and let its servers catch up. If the position is current but cell counts differ from other regions, rebuild those servers from the latest snapshot and replay the stream.
