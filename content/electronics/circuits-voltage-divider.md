# Circuits: Series, Parallel & the Voltage Divider

Every circuit so far has been one loop with one thing in it. That is enough to explain current and voltage, and not enough to build anything.

Add a second component and a genuinely new question appears. There are now two ways to connect it, they behave completely differently, and one of them leads to the most reused trick in electronics.

## Two ways to connect two things

**In series** means one after the other, on a single path. Charge that goes through the first has no choice but to go through the second.

**In parallel** means side by side, both bridging the same two points. Charge arriving at the junction picks a route.

<div class="diagram-wrap">
<svg viewBox="0 0 640 250" width="640" height="250" role="img" aria-label="Two circuits side by side, one with two resistors in series on a single path and one with two resistors in parallel across the same two points">
  <text x="160" y="28" text-anchor="middle" class="d-label">Series — one path</text>
  <text x="470" y="28" text-anchor="middle" class="d-label">Parallel — two paths</text>
  <path d="M 60 120 L 60 60 L 105 60" class="d-wire is-live"></path>
  <path d="M 145 60 L 175 60" class="d-wire is-live"></path>
  <path d="M 215 60 L 260 60 L 260 190 L 60 190 L 60 134" class="d-wire is-live"></path>
  <line x1="44" y1="120" x2="76" y2="120" class="d-batt-long"></line>
  <line x1="52" y1="134" x2="68" y2="134" class="d-batt-short"></line>
  <rect x="105" y="50" width="40" height="20" class="d-sym-body is-accent"></rect>
  <text x="125" y="42" text-anchor="middle" class="d-sym-label" font-size="11">R1</text>
  <rect x="175" y="50" width="40" height="20" class="d-sym-body is-accent"></rect>
  <text x="195" y="42" text-anchor="middle" class="d-sym-label" font-size="11">R2</text>
  <text x="160" y="150" text-anchor="middle" class="d-sym-note">Same current through both.</text>
  <text x="160" y="167" text-anchor="middle" class="d-sym-note">They share the voltage.</text>
  <path d="M 370 120 L 370 60 L 430 60" class="d-wire is-live"></path>
  <path d="M 470 60 L 560 60 L 560 190 L 370 190 L 370 134" class="d-wire is-live"></path>
  <path d="M 430 130 L 400 130 L 400 60" class="d-wire is-live"></path>
  <path d="M 470 130 L 530 130 L 530 60" class="d-wire is-live"></path>
  <line x1="354" y1="120" x2="386" y2="120" class="d-batt-long"></line>
  <line x1="362" y1="134" x2="378" y2="134" class="d-batt-short"></line>
  <rect x="430" y="50" width="40" height="20" class="d-sym-body is-accent"></rect>
  <text x="450" y="42" text-anchor="middle" class="d-sym-label" font-size="11">R1</text>
  <rect x="430" y="120" width="40" height="20" class="d-sym-body is-accent"></rect>
  <text x="450" y="112" text-anchor="middle" class="d-sym-label" font-size="11">R2</text>
  <circle cx="400" cy="60" r="4" class="d-node"></circle>
  <circle cx="530" cy="60" r="4" class="d-node"></circle>
  <text x="470" y="167" text-anchor="middle" class="d-sym-note">Same voltage across both.</text>
  <text x="470" y="184" text-anchor="middle" class="d-sym-note">They share the current.</text>
  <rect x="120" y="205" width="400" height="34" rx="8" class="d-note"></rect>
  <text x="320" y="227" text-anchor="middle" class="d-note-text" font-size="12">Series shares current and splits voltage. Parallel shares voltage and splits current.</text>
  <defs></defs>
</svg>
<div class="diagram-caption">The two arrangements are near-mirror images. Whichever quantity is forced to be equal, the other one gets divided up.</div>
</div>

That last line is the whole page in one sentence. Everything below is working out what it implies.

## The two rules underneath

Both arrangements follow from two statements so simple they look like they cannot be useful. They are named after Kirchhoff, and they are the foundation of analysing any circuit at all.

**Rule one: whatever flows into a junction flows out of it.**

Charge cannot pile up at a point, and it cannot disappear. If 3 amps arrive at a junction and 1 amp leaves down one branch, exactly 2 amps leave down the other. This is bookkeeping, not physics.

**Rule two: go around any loop, adding up the voltages, and you end where you started at zero.**

Every push from a battery is exactly matched by the drops across everything in the loop. A 9 V battery with two resistors in series will always have 9 V split between them — perhaps 6 and 3, perhaps 8 and 1, but always totalling 9.

The altitude picture from the voltage page carries over perfectly here. Walk a loop on a hill, climbing and descending, and by the time you return to your front door your net change in height is zero. It has to be. You are back where you started.

### What follows for series

The same current goes through both resistors, and the two voltage drops must add up to the source.

That means **series resistances just add**:

> **R = R₁ + R₂**

Which makes sense from the last page. Two resistors in series is a longer obstacle course, and length adds resistance.

### What follows for parallel

Both resistors have the same voltage across them, and each carries its own current. Adding a second path can only ever let *more* current flow.

So **parallel resistance is always smaller than either resistor on its own**:

> **1 / R = 1 / R₁ + 1 / R₂**

Two equal resistors in parallel give exactly half. It is a second checkout lane in a shop: the queue moves faster, never slower.

If that formula looks awkward, the shortcut worth memorising is that two in parallel come to their product over their sum — R₁R₂ / (R₁ + R₂).

## The voltage divider

Now the important part, and the reason series connection deserves a section of its own.

Two resistors in series across a battery. They must share the full voltage between them. And because the same current flows through both, the share each one takes is set purely by how big it is compared to the other.

Tap a wire off the point between them, and the voltage at that point is:

> **V_out = V_in × R₂ / (R₁ + R₂)**

This is a **voltage divider**. It takes a voltage in and gives a smaller, chosen fraction of it out. The fraction is a ratio, which is why the formula has no units and why it looks the way it does.

Drag the two resistors and watch the tap point move.

<div class="diagram-wrap" data-calc>
<svg viewBox="0 0 600 280" width="600" height="280" role="img" aria-label="Two resistors in series across a supply with an output tapped between them, and a bar showing the resulting output voltage">
  <path d="M 150 40 L 150 60" class="d-wire is-live"></path>
  <path d="M 150 110 L 150 150" class="d-wire is-live"></path>
  <path d="M 150 200 L 150 220" class="d-wire is-live"></path>
  <line x1="110" y1="40" x2="190" y2="40" class="d-wire is-live"></line>
  <text x="100" y="44" text-anchor="end" class="d-sym-label">V_in</text>
  <text x="100" y="60" text-anchor="end" class="d-sym-value"><tspan data-calc-expr="Vin" data-calc-digits="1">9</tspan> V</text>
  <rect x="130" y="60" width="40" height="50" class="d-sym-body is-accent"></rect>
  <text x="185" y="82" class="d-sym-label" font-size="11">R1</text>
  <text x="185" y="98" class="d-sym-value" font-size="11"><tspan data-calc-expr="R1" data-calc-digits="0">1000</tspan> Ω</text>
  <rect x="130" y="150" width="40" height="50" class="d-sym-body is-accent"></rect>
  <text x="185" y="172" class="d-sym-label" font-size="11">R2</text>
  <text x="185" y="188" class="d-sym-value" font-size="11"><tspan data-calc-expr="R2" data-calc-digits="0">1000</tspan> Ω</text>
  <circle cx="150" cy="130" r="4.5" class="d-node"></circle>
  <path d="M 150 130 L 290 130" class="d-wire is-live"></path>
  <text x="300" y="126" class="d-sym-label">V_out</text>
  <text x="300" y="144" class="d-sym-value" data-calc-out="Vout">4.5 V</text>
  <line x1="130" y1="220" x2="170" y2="220" class="d-gnd"></line>
  <line x1="138" y1="228" x2="162" y2="228" class="d-gnd"></line>
  <line x1="145" y1="236" x2="155" y2="236" class="d-gnd"></line>
  <text x="150" y="255" text-anchor="middle" class="d-sym-note">ground — the chosen 0 V</text>
  <rect x="470" y="40" width="46" height="180" class="d-level-track"></rect>
  <rect x="470" y="130" width="46" height="90" class="d-level" data-calc-attr="height" data-calc-expr="180*(R2/(R1+R2))"></rect>
  <rect x="470" y="130" width="46" height="90" class="d-level" data-calc-attr="y" data-calc-expr="220-180*(R2/(R1+R2))"></rect>
  <text x="493" y="32" text-anchor="middle" class="d-sym-note">V_in</text>
  <text x="493" y="238" text-anchor="middle" class="d-sym-note">0 V</text>
  <text x="537" y="130" class="d-sym-note">the tap</text>
  <defs></defs>
</svg>
<script type="application/json" class="calc-spec">
{
"inputs": [
{"id": "Vin", "label": "Supply", "min": 1, "max": 12, "step": 0.5, "value": 9, "unit": "V", "digits": 1},
{"id": "R1", "label": "R1 (top)", "min": 100, "max": 10000, "step": 100, "value": 1000, "unit": "Ω", "digits": 0},
{"id": "R2", "label": "R2 (bottom)", "min": 100, "max": 10000, "step": 100, "value": 1000, "unit": "Ω", "digits": 0}
],
"outputs": [
{"id": "Vout", "label": "Output", "expr": "Vin * R2 / (R1 + R2)", "unit": "V", "digits": 2},
{"id": "Iq", "label": "Current wasted", "expr": "Vin / (R1 + R2) * 1000", "unit": "mA", "digits": 2},
{"id": "ratio", "label": "Share taken by R2", "expr": "R2 / (R1 + R2) * 100", "unit": "%", "digits": 0}
],
"notes": [
{"when": "R1 + R2 < 600", "text": "<strong>Small resistors give the same ratio and waste far more current.</strong> Both resistors are permanently conducting, so a divider is always drawing from the supply. On a battery-powered board this is one of the things that quietly flattens the battery overnight."}
]
}
</script>
<div class="diagram-caption">The output depends only on the <em>ratio</em> of the two resistors, not their size. Scale both by ten and the output is identical — but the current wasted drops by ten.</div>
</div>

Three things are worth pulling out of that.

**Only the ratio matters.** 1 kΩ and 1 kΩ gives you half. So does 10 kΩ and 10 kΩ. So does 1 MΩ and 1 MΩ. Every one of them outputs exactly half.

**But the size still matters, for a different reason.** Both resistors conduct all the time, so a divider is always quietly burning current between the supply and ground. Pick values that are too small and you waste power for nothing. Pick them enormous and the output becomes fragile, for the reason below.

**A divider is not a power supply.** This is the trap everyone falls into once. If you connect something to the tap that actually draws current, that thing is now in parallel with R₂ — which changes the resistance, which changes the ratio, which changes the output voltage. A divider gives a reliable *signal*, not a reliable *supply*. The rule of thumb is that whatever you connect should have far more resistance than R₂, so it barely disturbs the split.

## Where dividers show up

Once you can see the pattern, it is everywhere.

**A potentiometer** — the volume knob — is a single strip of resistive material with a sliding contact. Moving the contact makes the part above it R₁ and the part below it R₂. It is a voltage divider you can turn with your fingers.

**Sensors.** A great many sensors are simply resistors that change with the world: hotter, more resistance; brighter, less resistance; more pressure, less resistance. On its own that is useless, because a chip reads voltage, not resistance. Put the sensor in a divider with a fixed resistor and its changing resistance becomes a changing voltage. That is how nearly every analog sensor reaches a chip.

**Bringing a voltage down to a safe level.** Feeding a 12 V signal into a chip that tolerates 3.3 V destroys the chip. A divider scales it into range first.

**Pull-up resistors**, which get a proper treatment later in this track, are a divider where one half is a switch. When the switch is open the output is pulled to one rail; when it closes, the ratio collapses and the output snaps to the other.

## Reading a schematic

A couple of conventions in the diagram above are worth naming, since every later page uses them.

**Ground** is drawn as that descending stack of lines. It is the point chosen as 0 V. Every ground symbol in a schematic is the same electrical point, even though they are drawn separately and not joined by any visible wire. This is a convenience that stops schematics turning into spaghetti.

**The supply** is drawn at the top and ground at the bottom, so voltage on the page runs downhill. This is only a habit, but it is a universal one, and it means you can read roughly what a circuit does by its shape.

**A dot at a crossing means connected.** Wires that cross with no dot are not touching. That one small mark is the difference between two separate signals and a short circuit.

## Where this leads

- **Series** connections share current and split voltage; resistances add.
- **Parallel** connections share voltage and split current; the total is always less than either.
- **Kirchhoff's rules** — current balances at a junction, voltages balance around a loop — are all the bookkeeping needed to analyse any of it.
- **A voltage divider** turns a ratio of resistances into a chosen fraction of a voltage, and it is the single most reused arrangement in electronics.

Every circuit up to here has been static. Connect it and it instantly settles into one set of values, and stays there forever.

Real systems do not behave like that, and computers depend on them not behaving like that. The next page introduces the first component with a sense of time — one that takes a while to fill up, and a while to empty.
