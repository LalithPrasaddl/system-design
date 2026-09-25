# Resistance, Ohm's Law & Power

Take the battery and the bulb from the last page. Now take the bulb out and join the two wires straight to each other.

The battery gets hot. It may get hot enough to burn you, and it will be flat in minutes.

Nothing was added to the circuit, so nothing should have gone wrong. Something clearly did. The missing idea is **resistance**, and it is the reason a circuit needs things in it, not just wire.

## Why anything resists at all

Go back to what is physically happening inside the metal.

Electrons are drifting along the wire. But the wire is not empty space. It is a dense, packed grid of atoms, and those atoms are vibrating in place.

A drifting electron does not sail through. It runs into things. It gets knocked sideways, slowed down, sent off course, and then pushed forward again by the voltage. It is a constant cycle of being sped up and then bumped to a stop.

**Resistance is a measure of how much the material gets in the way of that drift.**

A useful picture is walking across a room. An empty room, and you cross at full speed. Fill the room with people standing around and you cross the same distance far more slowly, because you keep having to squeeze past. You are pushing just as hard. You are simply getting less far for it.

<div class="diagram-wrap">
<svg viewBox="0 0 640 220" width="640" height="220" role="img" aria-label="Two wires side by side, one wide with few obstacles and one narrow and crowded, showing how the same push produces different amounts of drift">
  <text x="160" y="26" text-anchor="middle" class="d-label">Low resistance</text>
  <text x="480" y="26" text-anchor="middle" class="d-label">High resistance</text>
  <rect x="30" y="50" width="260" height="70" rx="6" class="d-sym-body"></rect>
  <rect x="350" y="50" width="260" height="70" rx="6" class="d-sym-body"></rect>
  <circle cx="70" cy="70" r="7" class="d-node-open"></circle>
  <circle cx="140" cy="100" r="7" class="d-node-open"></circle>
  <circle cx="215" cy="66" r="7" class="d-node-open"></circle>
  <circle cx="265" cy="102" r="7" class="d-node-open"></circle>
  <circle cx="372" cy="68" r="7" class="d-node-open"></circle>
  <circle cx="400" cy="102" r="7" class="d-node-open"></circle>
  <circle cx="428" cy="66" r="7" class="d-node-open"></circle>
  <circle cx="456" cy="104" r="7" class="d-node-open"></circle>
  <circle cx="484" cy="70" r="7" class="d-node-open"></circle>
  <circle cx="512" cy="100" r="7" class="d-node-open"></circle>
  <circle cx="540" cy="66" r="7" class="d-node-open"></circle>
  <circle cx="568" cy="102" r="7" class="d-node-open"></circle>
  <circle cx="596" cy="72" r="7" class="d-node-open"></circle>
  <path d="M 40 85 L 105 85 L 120 72 L 175 72 L 190 96 L 250 96 L 262 82 L 282 82" class="d-msg d-request" fill="none" marker-end="url(#arrowR1)"></path>
  <path d="M 358 85 L 382 85 L 390 70 L 410 88 L 418 74 L 436 92 L 444 76 L 462 92 L 470 72 L 492 90 L 500 76 L 520 90 L 528 74 L 548 90 L 556 78 L 576 92 L 584 82 L 600 82" class="d-msg d-request" fill="none" marker-end="url(#arrowR1)"></path>
  <text x="160" y="145" text-anchor="middle" class="d-sym-note">Few collisions. The drift adds up quickly.</text>
  <text x="480" y="145" text-anchor="middle" class="d-sym-note">Constant collisions. The same push, far less drift.</text>
  <rect x="80" y="170" width="480" height="36" rx="8" class="d-note"></rect>
  <text x="320" y="193" text-anchor="middle" class="d-note-text" font-size="12">Resistance does not block charge. It makes each unit of push produce less flow.</text>
  <defs>
    <marker id="arrowR1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The same voltage pushing through two different materials. Resistance is how much of that push gets wasted bumping into the material itself.</div>
</div>

Resistance is measured in **ohms**, written with the Greek letter omega: Ω.

Four things decide how much resistance a piece of material has, and all four make sense from the walking picture:

- **The material.** Copper is a wide corridor. Nichrome is a crowd.
- **Length.** Twice as far to walk is twice the resistance.
- **Thickness.** A wider corridor lets more people through at once, so thicker wire has *less* resistance.
- **Temperature.** Hot atoms vibrate harder and are harder to dodge, so metals resist more when hot.

## Ohm's law

Put voltage, current and resistance together and you get the single most used relationship in all of electronics.

> **V = I × R**
>
> Voltage equals current times resistance.

Read it in plain words: **the current that flows is set by how hard you push, divided by how much the material gets in the way.**

Rearranged into the form you will actually use most:

> **I = V / R**

That is the whole thing. More voltage, more current. More resistance, less current. There is no fourth factor hiding somewhere.

It is worth being clear about what kind of statement this is. Ohm's law is not a law of the universe in the way that conservation of charge is. It is a description of how *most* materials behave *most* of the time. Materials that follow it are called **ohmic**. Plenty of the components in this track — diodes and transistors especially — deliberately do not follow it, and that disobedience is precisely what makes them useful.

### Push on it

The formula is easier to trust once you have moved it around yourself. Drag either slider and watch what happens to the current.

<div class="diagram-wrap" data-calc>
<svg viewBox="0 0 600 240" width="600" height="240" role="img" aria-label="A battery connected to a single resistor in a loop, with live readouts for voltage, resistance, current and power">
  <path d="M 90 124 L 90 68 L 255 68" class="d-wire is-live"></path>
  <path d="M 335 68 L 510 68 L 510 190 L 90 190 L 90 138" class="d-wire is-live"></path>
  <line x1="70" y1="124" x2="110" y2="124" class="d-batt-long"></line>
  <line x1="80" y1="138" x2="100" y2="138" class="d-batt-short"></line>
  <text x="62" y="120" text-anchor="end" class="d-sym-label">+</text>
  <text x="62" y="145" text-anchor="end" class="d-sym-label">−</text>
  <text x="90" y="215" text-anchor="middle" class="d-sym-value"><tspan data-calc-expr="V" data-calc-digits="1">9</tspan> V</text>
  <rect x="255" y="56" width="80" height="24" class="d-sym-body is-accent"></rect>
  <text x="295" y="40" text-anchor="middle" class="d-sym-value"><tspan data-calc-expr="R" data-calc-digits="0">1000</tspan> Ω</text>
  <text x="295" y="103" text-anchor="middle" class="d-sym-note">the resistor</text>
  <path d="M 380 68 L 420 68" class="d-msg d-request" marker-end="url(#arrowR2)"></path>
  <text x="400" y="56" text-anchor="middle" class="d-sym-value" data-calc-out="I">9 mA</text>
  <rect x="150" y="150" width="300" height="1" class="d-level-track"></rect>
  <text x="300" y="170" text-anchor="middle" class="d-sym-note">current is the same everywhere in this loop</text>
  <defs>
    <marker id="arrowR2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<script type="application/json" class="calc-spec">
{
"inputs": [
{"id": "V", "label": "Battery", "min": 1, "max": 12, "step": 0.5, "value": 9, "unit": "V", "digits": 1},
{"id": "R", "label": "Resistor", "min": 50, "max": 10000, "step": 50, "value": 1000, "unit": "Ω", "digits": 0}
],
"outputs": [
{"id": "I", "label": "Current", "expr": "V / R * 1000", "unit": "mA", "digits": 1},
{"id": "P", "label": "Power as heat", "expr": "V * V / R * 1000", "unit": "mW", "digits": 0, "warnAbove": 250}
],
"notes": [
{"when": "V / R > 0.25", "text": "<strong>That is a lot of current for a small part.</strong> A common quarter-watt resistor turns this much energy into heat faster than it can shed it. In a real circuit this is the point where it discolours, then smells, then fails."}
]
}
</script>
<div class="diagram-caption">One battery, one resistor. Halve the resistance and the current doubles — but the heat quadruples, which is the part the formula hides until you watch the second number move.</div>
</div>

Two things are worth noticing while you drag.

Current tracks voltage in a straight line. Double the voltage, double the current, every time.

Power does not. That number climbs far faster than the others, and it is the reason the next section exists.

## Power: where the energy goes

Charge arrives at the resistor with energy and leaves without it. That energy does not vanish. It becomes heat.

**Power** is how fast energy is being turned into something else. It is measured in **watts**, written W. One watt is one joule of energy every second.

> **P = V × I**
>
> Power equals voltage times current.

This follows directly from the two definitions you already have. Voltage is energy per unit of charge. Current is charge per second. Multiply them and the charge cancels out, leaving energy per second.

Substituting Ohm's law gives the two forms that get used in practice:

> **P = I² × R**  and  **P = V² / R**

The squared terms are the important part. **Double the current through something and it gets four times as hot.** Not twice. Four times.

That single fact explains an enormous amount:

- Why a phone charger is warm and a kettle is dangerous.
- Why power is sent across countries at very high voltage — high voltage means low current for the same energy delivered, and it is the *current* that heats the cables.
- Why chips have heatsinks, and why making a processor faster makes it hotter far quicker than you would hope.

### And the short circuit

Now the opening puzzle answers itself.

Connect a battery's two terminals with nothing but wire, and R is nearly zero. Ohm's law says current is V divided by R. Divide by something very close to zero and you get a very large number.

A huge current flows. The only resistance in the loop is the small amount inside the battery itself and in the wire, so that is where all the power is dumped. Both get hot fast.

That is a **short circuit**: an unintended low-resistance path. Nothing exotic broke. The formula simply did what it always does.

## What a resistor is for

A resistor is a component built to have one specific, stable resistance and to do nothing else.

That sounds dull. It is one of the most used parts in existence, because "deliberately limit the current here" is a constant need:

- An LED will draw as much current as it is offered and destroy itself. A resistor in series with it sets the current to something it survives.
- A sensor's output needs to become a voltage a chip can read. A resistor turns a current into a voltage, at a rate you choose.
- A chip input left unconnected picks up electrical noise and reads as random. A resistor gently ties it to a known voltage, which is the pull-up resistor you will meet later in this track.

Real resistors come in standard values — 220 Ω, 1 kΩ, 4.7 kΩ, 10 kΩ recur constantly — and carry a **tolerance**, usually ±1% or ±5%, because manufacturing is never exact. They also carry a **power rating**, typically a quarter of a watt for small ones. That rating is not about voltage or current individually. It is the answer to "how fast can this part get rid of heat before it cooks", which is exactly the number the slider above was warning you about.

## Some numbers worth having

| Thing | Roughly |
|---|---|
| 1 m of thin hookup wire | 0.02 Ω |
| A typical LED current-limiting resistor | 220 Ω – 1 kΩ |
| A chip's pull-up resistor | 10 kΩ |
| Dry human skin, hand to hand | 100 kΩ or more |
| A kettle element | 20 Ω |
| Good insulator (plastic, glass) | billions of Ω |

The span from a wire to an insulator is more than a trillion to one. Almost everything in electronics is about placing something at a chosen point on that scale.

## Where this leads

- **Resistance** is how much a material obstructs drifting charge, measured in ohms.
- **Ohm's law**, I = V / R, sets the current from the push and the obstruction.
- **Power**, P = V × I, is how fast energy becomes heat — and it rises with the *square* of current, which is why heat is the limit on nearly everything.

So far every circuit here has been one battery and one component in a single loop. Real circuits are not that. The moment there are two components, a question appears that Ohm's law alone cannot answer: how do they share the voltage between them?

The answer is the voltage divider, and it turns out to be the most reused pattern in all of electronics.
