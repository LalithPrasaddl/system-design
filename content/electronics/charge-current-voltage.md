# Charge, Current & Voltage

A battery, two pieces of wire, and a small bulb. Connect them in a loop and the bulb lights up. Leave it long enough and the battery goes flat.

Something moved. Something ran out. This page is about what those two things actually are, because almost everything else in electronics is built on top of them.

## What is already inside a wire

Everything is made of atoms. An atom has a heavy centre, called the nucleus, with much lighter **electrons** around it.

Electrons carry a property called **charge**. Charge is the thing electricity is made of, in the same way that water is the thing plumbing is made of.

In most materials, electrons are held tightly to their own atom and cannot go anywhere. Those materials are **insulators** — plastic, glass, rubber, dry air.

In metals, something different happens. Each atom lets go of an electron or two, and those electrons wander freely between the atoms. Metals are **conductors** because they are full of loose electrons.

So here is the first thing worth getting right:

**A copper wire is already packed with free electrons before you connect anything to it.** They are not sitting still, either. They are moving constantly, fast, in random directions — bouncing around like a crowd of people milling about in a hall. Every direction is equally represented, so nothing gets anywhere.

<div class="diagram-wrap">
<svg viewBox="0 0 640 250" width="640" height="250" role="img" aria-label="Two panels showing electrons inside a copper wire, moving randomly when nothing is connected and drifting together when a battery is connected">
  <text x="160" y="28" text-anchor="middle" class="d-label">Nothing connected</text>
  <text x="480" y="28" text-anchor="middle" class="d-label">Battery connected</text>
  <rect x="25" y="55" width="270" height="75" rx="8" class="d-actor-box"></rect>
  <rect x="345" y="55" width="270" height="75" rx="8" class="d-actor-box"></rect>
  <line x1="60" y1="80" x2="76" y2="68" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="108" y1="108" x2="92" y2="118" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="152" y1="74" x2="152" y2="92" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="196" y1="112" x2="213" y2="104" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="240" y1="82" x2="225" y2="72" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="82" y1="116" x2="66" y2="110" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="264" y1="110" x2="272" y2="94" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="128" y1="116" x2="141" y2="122" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <circle cx="60" cy="80" r="5" class="d-block d-block-request"></circle>
  <circle cx="108" cy="108" r="5" class="d-block d-block-request"></circle>
  <circle cx="152" cy="74" r="5" class="d-block d-block-request"></circle>
  <circle cx="196" cy="112" r="5" class="d-block d-block-request"></circle>
  <circle cx="240" cy="82" r="5" class="d-block d-block-request"></circle>
  <circle cx="82" cy="116" r="5" class="d-block d-block-request"></circle>
  <circle cx="264" cy="110" r="5" class="d-block d-block-request"></circle>
  <circle cx="128" cy="116" r="5" class="d-block d-block-request"></circle>
  <line x1="383" y1="78" x2="401" y2="78" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="428" y1="106" x2="446" y2="106" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="473" y1="74" x2="491" y2="74" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="518" y1="112" x2="536" y2="112" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="563" y1="84" x2="581" y2="84" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="403" y1="118" x2="421" y2="118" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="588" y1="108" x2="606" y2="108" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <line x1="451" y1="120" x2="469" y2="120" class="d-msg d-request" marker-end="url(#arrowE1)"></line>
  <circle cx="375" cy="78" r="5" class="d-block d-block-request"></circle>
  <circle cx="420" cy="106" r="5" class="d-block d-block-request"></circle>
  <circle cx="465" cy="74" r="5" class="d-block d-block-request"></circle>
  <circle cx="510" cy="112" r="5" class="d-block d-block-request"></circle>
  <circle cx="555" cy="84" r="5" class="d-block d-block-request"></circle>
  <circle cx="395" cy="118" r="5" class="d-block d-block-request"></circle>
  <circle cx="580" cy="108" r="5" class="d-block d-block-request"></circle>
  <circle cx="443" cy="120" r="5" class="d-block d-block-request"></circle>
  <text x="160" y="155" text-anchor="middle" class="d-label-muted" font-size="11">Moving fast, but every direction at once.</text>
  <text x="160" y="172" text-anchor="middle" class="d-label-muted" font-size="11">Nothing gets anywhere.</text>
  <text x="480" y="155" text-anchor="middle" class="d-label-muted" font-size="11">The same electrons, now with a slow</text>
  <text x="480" y="172" text-anchor="middle" class="d-label-muted" font-size="11">drift added in one direction.</text>
  <rect x="80" y="196" width="480" height="40" rx="8" class="d-note"></rect>
  <text x="320" y="221" text-anchor="middle" class="d-note-text" font-size="12">A battery does not supply the electrons. It makes the ones already there drift together.</text>
  <defs>
    <marker id="arrowE1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Connecting a battery does not fill an empty wire. It adds a slow, shared drift on top of motion that was already happening.</div>
</div>

### Measuring charge

Charge is measured in **coulombs**, written C. One coulomb is about 6,200,000,000,000,000,000 electrons.

That number is not worth memorising. What is worth taking from it is that a coulomb is simply a *count* of charge, the way "a dozen" is a count of eggs. Nothing more complicated is going on.

## Current: charge that is moving

**Current** is how much charge goes past a point each second.

It is measured in **amperes**, usually shortened to amps and written A. One amp means one coulomb of charge passes by every second.

A useful way to picture it: stand on a bridge over a motorway and count the cars passing underneath each minute. That count is the traffic flow. It does not tell you how fast any individual car is going, and you do not need to know. Current is the same kind of number — charge passing a point per second.

### Electrons are slow, electricity is not

Here is something that surprises most people, and getting it straight early prevents a lot of confusion later.

In a wire carrying a normal amount of current, the individual electrons drift along at a fraction of a millimetre per second. That is slower than a snail. An electron leaving a battery might take over an hour to travel a single metre of wire.

And yet a light comes on the instant you flick the switch.

Both things are true, because **the electrons do not need to travel from the switch to the bulb**. The wire is already full of them, all the way along. When the battery starts pushing, every electron in the wire starts drifting at nearly the same moment — the push travels through the wire close to the speed of light, even though the electrons themselves barely crawl.

A bicycle chain works the same way. Push the pedal and the back wheel turns immediately. No single link of the chain had to travel from the pedal to the wheel. The whole chain was already in place and simply started moving at once.

### One piece of historical baggage

Current is drawn and described as flowing from the **positive** terminal of a battery, around the circuit, to the **negative** terminal.

Electrons actually move the other way — from negative to positive.

This is a genuine mistake. The direction was chosen before anyone knew electrons existed, it turned out to be backwards, and by then it was in every book and every diagram, so it was never corrected. It is called **conventional current**, and everybody still uses it.

It changes nothing about how circuits work or how you analyse them. Learn it once, accept it, and move on.

## Voltage: the push

Charge does not start moving on its own. Something has to push it. That push is **voltage**, measured in **volts** and written V.

The everyday version of this is height. Water in a flat pipe just sits there. Lift one end and it flows, and the steeper the slope, the harder it flows. Voltage is the electrical equivalent of that height difference.

A battery is a small chemical pump. It uses a chemical reaction to hold one of its terminals at a higher electrical "height" than the other, and it keeps doing that until the chemicals are used up. That is what going flat means.

The precise definition is worth seeing once, because it explains where the energy in a circuit comes from:

> **One volt means one joule of energy given to each coulomb of charge.**

So voltage is energy *per unit of charge*. A 9 V battery gives each coulomb passing through it nine times as much energy as a 1 V battery would. That energy is what the charge carries around the circuit and gives up in whatever it passes through.

### Voltage is always between two points

This is the single most important idea on this page, and the one most often glossed over.

There is no such thing as "the voltage at this wire". There is only "the voltage *between* this wire and that other point".

Think about altitude. If someone asks how high a table is, the question is incomplete until you say what it is measured from. Above the floor? Above sea level? Above the centre of the Earth? The table has not changed. Only the reference point has.

Voltage works exactly like this. When a battery is labelled 9 V, that means nine volts **between its two terminals**. It does not mean nine volts are stored inside it in some absolute sense.

Because the reference is a choice, you have to make one, and in circuits that chosen reference point has a name: **ground**. Ground is simply the point everyone has agreed to call zero volts, so that every other voltage can be quoted as a single number instead of a pair.

Nothing is physically special about the point chosen as ground. Choose a different one and every number in the circuit changes — but every *difference* stays exactly the same, and the circuit behaves identically, because differences are the only thing the circuit responds to.

<div class="diagram-wrap">
<svg viewBox="0 0 620 300" width="620" height="300" role="img" aria-label="The same two-battery stack labelled twice with different reference points chosen, showing all voltages change but the differences stay the same">
  <text x="150" y="26" text-anchor="middle" class="d-label">Call the bottom zero</text>
  <text x="460" y="26" text-anchor="middle" class="d-label">Call the middle zero</text>
  <line x1="150" y1="58" x2="150" y2="82" class="d-axis"></line>
  <line x1="150" y1="132" x2="150" y2="152" class="d-axis"></line>
  <line x1="150" y1="202" x2="150" y2="226" class="d-axis"></line>
  <rect x="115" y="82" width="70" height="50" rx="6" class="d-actor-box"></rect>
  <text x="150" y="112" text-anchor="middle" class="d-actor-label" font-size="12">1.5 V</text>
  <rect x="115" y="152" width="70" height="50" rx="6" class="d-actor-box"></rect>
  <text x="150" y="182" text-anchor="middle" class="d-actor-label" font-size="12">1.5 V</text>
  <circle cx="150" cy="58" r="5" class="d-block d-block-request"></circle>
  <circle cx="150" cy="142" r="5" class="d-block d-block-request"></circle>
  <circle cx="150" cy="226" r="5" class="d-block d-block-request"></circle>
  <text x="200" y="62" class="d-label" font-size="12">A  =  +3 V</text>
  <text x="200" y="146" class="d-label" font-size="12">B  =  +1.5 V</text>
  <text x="200" y="230" class="d-label" font-size="12">C  =  0 V</text>
  <text x="200" y="246" class="d-note-text" font-size="11">chosen as zero</text>
  <line x1="460" y1="58" x2="460" y2="82" class="d-axis"></line>
  <line x1="460" y1="132" x2="460" y2="152" class="d-axis"></line>
  <line x1="460" y1="202" x2="460" y2="226" class="d-axis"></line>
  <rect x="425" y="82" width="70" height="50" rx="6" class="d-actor-box"></rect>
  <text x="460" y="112" text-anchor="middle" class="d-actor-label" font-size="12">1.5 V</text>
  <rect x="425" y="152" width="70" height="50" rx="6" class="d-actor-box"></rect>
  <text x="460" y="182" text-anchor="middle" class="d-actor-label" font-size="12">1.5 V</text>
  <circle cx="460" cy="58" r="5" class="d-block d-block-request"></circle>
  <circle cx="460" cy="142" r="5" class="d-block d-block-request"></circle>
  <circle cx="460" cy="226" r="5" class="d-block d-block-request"></circle>
  <text x="510" y="62" class="d-label" font-size="12">A  =  +1.5 V</text>
  <text x="510" y="146" class="d-label" font-size="12">B  =  0 V</text>
  <text x="510" y="162" class="d-note-text" font-size="11">chosen as zero</text>
  <text x="510" y="230" class="d-label" font-size="12">C  =  −1.5 V</text>
  <rect x="70" y="262" width="480" height="30" rx="8" class="d-note"></rect>
  <text x="310" y="282" text-anchor="middle" class="d-note-text" font-size="12">Every number changed. A is still 3 V above C in both. Only differences matter.</text>
  <defs></defs>
</svg>
<div class="diagram-caption">The same two batteries, labelled twice. Choosing a different zero rewrites every number on the diagram and changes nothing about the circuit.</div>
</div>

## Water, and where the comparison stops working

The water comparison is genuinely useful, so it is worth laying out properly — and then being clear about the one place it will mislead you.

| | Water | Electricity |
|---|---|---|
| The stuff itself | Water | Charge, measured in coulombs |
| How much is flowing | Litres per second | Current, measured in amps |
| What makes it flow | Pressure, or a height difference | Voltage, measured in volts |
| What restricts it | A narrow pipe | Resistance |

Where it breaks: **water can leave the system, and charge cannot.**

Cut a water pipe and water sprays out of the gap. Cut a wire and nothing pours out of the ends. Instead, the flow stops completely — not just at the cut, but everywhere in the circuit at the same moment.

That single difference is why circuits have to be loops.

## A circuit has to be a complete loop

Charge is not consumed by a circuit. Every electron that leaves one terminal of the battery arrives back at the other. The circuit is a ring, and the battery keeps pushing charge around that ring.

If the ring is broken at any point, everything stops everywhere. A switch is nothing more than a deliberate, controllable break in the ring.

<div class="diagram-wrap" data-flow-player>
<svg viewBox="0 0 600 300" width="600" height="300" role="img" aria-label="A battery, a switch and a bulb wired in a single loop, with the wires drawn as a closed ring">
  <rect x="50" y="115" width="90" height="72" rx="8" class="d-actor-box"></rect>
  <text x="95" y="145" text-anchor="middle" class="d-actor-label" font-size="12">Battery</text>
  <text x="95" y="163" text-anchor="middle" class="d-label-muted" font-size="11">1.5 V</text>
  <text x="80" y="108" text-anchor="middle" class="d-label" font-size="13">+</text>
  <text x="80" y="205" text-anchor="middle" class="d-label" font-size="13">−</text>
  <g data-fail-toggle="sw1">
    <rect x="245" y="48" width="84" height="42" rx="8" class="d-actor-box"></rect>
    <text x="287" y="74" text-anchor="middle" class="d-actor-label" font-size="12">Switch</text>
  </g>
  <g data-fail-toggle="bulb1">
    <rect x="430" y="115" width="90" height="72" rx="8" class="d-actor-box"></rect>
    <text x="475" y="152" text-anchor="middle" class="d-actor-label" font-size="12">Bulb</text>
  </g>
  <path id="e-w1" d="M 95 113 L 95 70 L 241 70" class="d-msg d-request" fill="none" data-depends-on="sw1 bulb1" marker-end="url(#arrowE2)"></path>
  <path id="e-w2" d="M 333 70 L 475 70 L 475 113" class="d-msg d-request" fill="none" data-depends-on="sw1 bulb1" marker-end="url(#arrowE2)"></path>
  <path id="e-w3" d="M 475 189 L 475 232 L 300 232" class="d-msg d-request" fill="none" data-depends-on="sw1 bulb1" marker-end="url(#arrowE2)"></path>
  <path id="e-w4" d="M 300 232 L 95 232 L 95 189" class="d-msg d-request" fill="none" data-depends-on="sw1 bulb1" marker-end="url(#arrowE2)"></path>
  <text x="300" y="285" text-anchor="middle" class="d-label-muted" font-size="10">open the switch, then try to play a flow — it cannot start anywhere</text>
  <defs>
    <marker id="arrowE2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="flow-spec">
{
"state": [
{"id": "count", "title": "Charge passing each second", "rows": [["top wire", "—"], ["through the bulb", "—"], ["bottom wire", "—"]]},
{"id": "energy", "title": "Volts above the − terminal", "rows": [["top wire", "—"], ["bottom wire", "—"], ["given up in the bulb", "—"]]}
],
"flows": [
{
"id": "current",
"label": "Current is the same all the way round",
"nodes": ["sw1", "bulb1"],
"steps": [
{"el": "e-w1", "payload": "0.2 A", "set": {"count.top wire": "0.2 A"}, "text": "The battery pushes, and the charge that was already sitting in this wire begins to drift. 0.2 amps means about a fifth of a coulomb goes past any point here every second."},
{"el": "e-w2", "payload": "0.2 A", "text": "Past the switch, still 0.2 amps. A closed switch takes nothing out of the circuit — its only job is to decide whether the loop exists at all."},
{"el": "e-w3", "payload": "0.2 A", "set": {"count.through the bulb": "0.2 A", "count.bottom wire": "0.2 A"}, "text": "Through the bulb and out the far side, and this is the part worth pausing on: exactly as much charge comes out as went in. The bulb is glowing, but it has not kept any charge. Nothing is used up here in the sense of being counted away."},
{"el": "e-w4", "payload": "0.2 A", "text": "Back into the − terminal, where the battery pushes it round again. The same 0.2 amps flows in every single part of this loop. In a simple ring like this one, current is shared, not divided."}
]
},
{
"id": "voltage",
"label": "Voltage is what actually changes",
"nodes": ["sw1", "bulb1"],
"steps": [
{"el": "e-w1", "payload": "1.5 V", "set": {"energy.top wire": "1.5 V", "count.top wire": "0.2 A"}, "text": "The same journey again, watching energy instead of quantity. Leaving the + terminal, every unit of charge carries the full push the battery gave it — 1.5 volts above the − terminal."},
{"el": "e-w2", "payload": "1.5 V", "text": "Still 1.5 volts on the far side of the switch. A plain copper wire takes almost nothing from the charge passing through it, and that is precisely what makes it useful as a wire rather than as a component."},
{"el": "e-w3", "payload": "0 V", "set": {"energy.bottom wire": "0 V", "energy.given up in the bulb": "1.5 V", "count.through the bulb": "0.2 A"}, "text": "Through the bulb, and out the other side with nothing left. All 1.5 volts were handed over inside the bulb, and that energy left the circuit as light and heat. This is what a component does: it takes energy from the charge passing through it, without keeping the charge."},
{"el": "e-w4", "payload": "0 V", "set": {"count.bottom wire": "0.2 A"}, "text": "The charge returns at 0 volts, drained but all present and accounted for. The battery lifts it back to 1.5 volts and the cycle repeats. Current is what is shared around the loop; voltage is what gets spent across the things in it."}
]
}
]
}
</script>
<div class="diagram-caption">Two ways of watching the same loop. The first follows how much charge moves — the same everywhere. The second follows how much energy each unit of charge still has — full before the bulb, nothing after it.</div>
</div>

<div class="fail-hint">Click the switch or the bulb to break the loop.</div>

<div class="failure-panel">
<div class="failure-impact is-hidden" data-component="sw1">
<strong>If the switch is opened:</strong> current stops instantly, everywhere in the circuit at once — including in the stretch of wire on the far side of the bulb, nowhere near the switch. Nothing leaks out of the open ends and nothing keeps flowing in the parts that are still connected. A gap anywhere in a single loop is a gap in the whole loop. Try playing either flow with the switch open: it cannot start, which is the honest result.
</div>
<div class="failure-impact is-hidden" data-component="bulb1">
<strong>If the bulb burns out:</strong> the thin wire inside it has got hot enough to melt through, leaving a gap. Electrically, that is the same event as opening the switch, and the outcome is identical — the loop is broken and everything stops. When a component in a simple loop goes "dead", it has usually just become a gap.
</div>
</div>

## Measuring the two

The difference between current and voltage shows up clearly in how each one is measured, and this is a good way to check the ideas have landed.

**To measure current, you have to break the circuit and insert the meter into the path**, so that all the charge flows through it and can be counted. You are counting things going past, so you have to stand in the stream.

**To measure voltage, you touch the meter to two points** without breaking anything. You are measuring a difference between two places, so you need to be in contact with both.

If the reason each one works that way is obvious to you, the concepts are solid. If not, it is worth rereading the section above on voltage being a difference — that is the idea both of these follow from.

## Some real numbers

Every number in electronics is written with a prefix, and they are used constantly:

| Prefix | Symbol | Means | Example |
|---|---|---|---|
| kilo | k | × 1,000 | 4.7 kΩ |
| milli | m | ÷ 1,000 | 20 mA |
| micro | µ | ÷ 1,000,000 | 10 µF |
| nano | n | ÷ 1,000,000,000 | 5 ns |

And some voltages and currents worth having a feel for:

| Thing | Voltage | Current |
|---|---|---|
| AA battery | 1.5 V | — |
| USB power | 5 V | up to 3 A |
| A logic chip inside a computer | 1.2 V – 3.3 V | — |
| A small indicator LED | ~2 V across it | 10 mA |
| Phone charging | 5 V | 1 – 2 A |
| Household mains | 120 V or 230 V | — |
| An electric kettle | 230 V | ~10 A |

Two things stand out from that table. Electronics — the signal-handling, thinking part — runs on small voltages and tiny currents. And the gap between a 10 mA LED and a 10 A kettle is a factor of a thousand, using the same basic ideas at both ends.

## Where this leads

Three quantities, and a clear job for each:

- **Charge** is the stuff, counted in coulombs.
- **Current** is charge moving past a point, measured in amps.
- **Voltage** is the push that makes it move, measured in volts, and it is always a difference between two points.

With just these, a useful definition of a component becomes possible. **Every electronic component is described by the relationship between the voltage across it and the current through it.** Some components let more current through as the voltage rises, in a straight, predictable line. Some let almost nothing through until a threshold is crossed, then let a lot through. Some let current pass one way and block it the other. One of them lets a voltage at one terminal control the current between two others — and that one turns out to be enough to build a computer.

Every component in the rest of this track is a different answer to that same question.
