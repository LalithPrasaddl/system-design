# Capacitors & Time

Every circuit so far has been instant. Connect it, and it immediately settles into one set of numbers and stays there.

That is a convenient fiction. Nothing is instant, and the component on this page is the reason why.

It is also the point where electronics stops being about steady values and starts being about *how long things take* — which is, eventually, the reason your computer has a clock speed at all.

## Two plates and a gap

A **capacitor** is about as simple as a component gets. Two pieces of metal, close together, not touching. An insulator between them.

Which looks like a broken circuit, because it is one. There is a gap. Charge cannot cross it.

So connect it to a battery and here is what actually happens.

The battery pulls electrons off the plate connected to its positive side and pushes them onto the plate connected to its negative side. One plate ends up short of electrons and positively charged. The other ends up with a surplus and negatively charged.

No charge crossed the gap. Charge was *rearranged around* the circuit, piling up on one plate and being stripped from the other.

<div class="diagram-wrap">
<svg viewBox="0 0 620 260" width="620" height="260" role="img" aria-label="A capacitor connected to a battery, showing electrons piling onto one plate and being pulled off the other while none cross the gap">
  <path d="M 90 120 L 90 60 L 290 60 L 290 108" class="d-wire is-live"></path>
  <path d="M 290 152 L 290 200 L 90 200 L 90 134" class="d-wire is-live"></path>
  <line x1="70" y1="120" x2="110" y2="120" class="d-batt-long"></line>
  <line x1="78" y1="134" x2="102" y2="134" class="d-batt-short"></line>
  <text x="60" y="118" text-anchor="end" class="d-sym-label">+</text>
  <text x="60" y="142" text-anchor="end" class="d-sym-label">−</text>
  <line x1="250" y1="108" x2="330" y2="108" class="d-plate"></line>
  <line x1="250" y1="152" x2="330" y2="152" class="d-plate"></line>
  <text x="345" y="104" class="d-sym-label" font-size="11">plate, short of electrons</text>
  <text x="345" y="158" class="d-sym-label" font-size="11">plate, surplus of electrons</text>
  <text x="290" y="136" text-anchor="middle" class="d-sym-note">the gap — nothing crosses</text>
  <circle cx="262" cy="98" r="4" class="d-node-open"></circle>
  <circle cx="278" cy="98" r="4" class="d-node-open"></circle>
  <circle cx="294" cy="98" r="4" class="d-node-open"></circle>
  <circle cx="262" cy="162" r="4" class="d-block d-block-request"></circle>
  <circle cx="278" cy="162" r="4" class="d-block d-block-request"></circle>
  <circle cx="294" cy="162" r="4" class="d-block d-block-request"></circle>
  <circle cx="310" cy="162" r="4" class="d-block d-block-request"></circle>
  <circle cx="326" cy="162" r="4" class="d-block d-block-request"></circle>
  <path d="M 150 48 L 200 48" class="d-msg d-request" marker-end="url(#arrowC1)"></path>
  <path d="M 230 212 L 180 212" class="d-msg d-request" marker-end="url(#arrowC1)"></path>
  <text x="175" y="38" text-anchor="middle" class="d-sym-note">electrons pulled away</text>
  <text x="205" y="230" text-anchor="middle" class="d-sym-note">electrons pushed on</text>
  <rect x="70" y="238" width="480" height="1" class="d-level-track"></rect>
  <defs>
    <marker id="arrowC1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Charge never crosses the gap. It piles up on one plate and is stripped from the other, which looks from outside exactly like current flowing through.</div>
</div>

This produces a genuinely strange result, and it is worth sitting with for a second.

**While a capacitor is charging, current flows in the circuit — even though the circuit is broken.**

A meter on either wire would read real current. Charge really is moving in the wires. It just is not moving through the gap. As soon as the plates are as full as the battery can make them, everything stops.

A rowing boat where the two rowers face each other and push on the same oar works like this. Neither passes anything to the other. Push one end and the other end moves. From outside, something clearly travelled across.

## Capacitance

**Capacitance** is how much charge a capacitor holds for each volt you put across it.

> **Q = C × V**
>
> Charge equals capacitance times voltage.

It is measured in **farads**, written F. One farad is an enormous amount — a coulomb of charge per volt. Real parts are almost always a millionth of that or smaller:

| Written | Means | Typical use |
|---|---|---|
| 100 pF | picofarads, 10⁻¹² F | high-speed signal timing |
| 100 nF | nanofarads, 10⁻⁹ F | the decoupling cap next to every chip |
| 10 µF | microfarads, 10⁻⁶ F | smoothing a power supply |
| 1 F | a supercapacitor | briefly powering a device |

Bigger plates hold more. Closer plates hold more. A better insulating material between them holds more. That is the whole design space, and it is why a capacitor with real capacitance is physically large compared to a resistor.

## Charging takes time

Here is the part that matters for everything later.

Put a resistor in front of a capacitor and charge it through that resistor. The capacitor does not fill instantly. It fills along a curve, and the shape of that curve is always the same.

The reason is a feedback effect worth following slowly.

At the start, the capacitor is empty, so there is no voltage across it. The full supply voltage appears across the resistor instead. By Ohm's law, that means a large current — so charge piles on fast.

As the plates fill, the capacitor's own voltage rises. That leaves *less* voltage across the resistor. Less voltage across the resistor means less current. Less current means it fills more slowly.

So the fuller it gets, the slower it fills. It approaches full and never quite arrives.

### The time constant

The time this takes is set by one number:

> **τ = R × C**
>
> The time constant, in seconds, is resistance times capacitance.

After one time constant, the capacitor has reached about **63%** of the way to full. Not most of the way, and not a quarter — 63%, every single time, regardless of the values.

After five time constants it is at 99.3%, and everyone agrees to call that full.

The key idea is that **every RC curve is the same curve**. Changing R or C does not change its shape at all. It only stretches or squashes it along the time axis. Drag the sliders below and watch the numbers on the axis change while the curve itself sits perfectly still.

<div class="diagram-wrap" data-calc>
<svg viewBox="0 0 600 300" width="600" height="300" role="img" aria-label="The charging curve of a capacitor, fixed in shape, with the time axis labels rescaling as resistance and capacitance change">
  <line x1="60" y1="40" x2="60" y2="200" class="d-axis"></line>
  <line x1="60" y1="200" x2="540" y2="200" class="d-axis"></line>
  <line x1="60" y1="61" x2="540" y2="61" class="d-marker-line"></line>
  <text x="548" y="65" class="d-sym-note">full</text>
  <line x1="60" y1="111.5" x2="152" y2="111.5" class="d-marker-line"></line>
  <text x="14" y="115" class="d-sym-value" font-size="11">63%</text>
  <line x1="152" y1="111.5" x2="152" y2="200" class="d-marker-line"></line>
  <polyline points="60,200 83,169.1 106,145 129,126.1 152,111.5 198,91.2 244,78.9 290,71.5 336,67 428,62.5 520,61" class="d-msg d-request" fill="none"></polyline>
  <text x="152" y="218" text-anchor="middle" class="d-sym-value" font-size="11"><tspan data-calc-expr="R*C" data-calc-digits="1">10</tspan></text>
  <text x="244" y="218" text-anchor="middle" class="d-sym-value" font-size="11"><tspan data-calc-expr="2*R*C" data-calc-digits="1">20</tspan></text>
  <text x="336" y="218" text-anchor="middle" class="d-sym-value" font-size="11"><tspan data-calc-expr="3*R*C" data-calc-digits="1">30</tspan></text>
  <text x="520" y="218" text-anchor="middle" class="d-sym-value" font-size="11"><tspan data-calc-expr="5*R*C" data-calc-digits="1">50</tspan></text>
  <text x="300" y="238" text-anchor="middle" class="d-sym-note">milliseconds</text>
  <text x="152" y="254" text-anchor="middle" class="d-sym-note">1τ</text>
  <text x="244" y="254" text-anchor="middle" class="d-sym-note">2τ</text>
  <text x="336" y="254" text-anchor="middle" class="d-sym-note">3τ</text>
  <text x="520" y="254" text-anchor="middle" class="d-sym-note">5τ</text>
  <text x="26" y="44" class="d-sym-note">V</text>
  <text x="300" y="282" text-anchor="middle" class="d-sym-note">the curve never changes shape — only the numbers under it do</text>
  <defs></defs>
</svg>
<script type="application/json" class="calc-spec">
{
"inputs": [
{"id": "R", "label": "Resistor", "min": 1, "max": 100, "step": 1, "value": 10, "unit": "kΩ", "digits": 0},
{"id": "C", "label": "Capacitor", "min": 0.1, "max": 100, "step": 0.1, "value": 1, "unit": "µF", "digits": 1}
],
"outputs": [
{"id": "tau", "label": "Time constant τ", "expr": "R * C", "unit": "ms", "digits": 2},
{"id": "full", "label": "Effectively full (5τ)", "expr": "5 * R * C", "unit": "ms", "digits": 1},
{"id": "freq", "label": "Fastest usable rate", "expr": "1000 / (5 * R * C)", "unit": "Hz", "digits": 0}
],
"notes": [
{"when": "5*R*C > 200", "text": "<strong>Slow enough to see.</strong> At this time constant a signal would take longer than a fifth of a second to settle — fine for a blinking light, hopeless for anything carrying data."}
]
}
</script>
<div class="diagram-caption">Resistance and capacitance set only the horizontal scale. The 63% point is always one time constant, and the curve is always this curve.</div>
</div>

Watch the third readout as you drag. That is the same fact stated as a speed limit: if a signal needs five time constants to settle, anything faster than that arrives before the voltage has got where it was going.

**Hold onto this.** It comes back twice in this track, and both times it is the thing that sets the limit:

- Every wire on a circuit board and every input on every chip has a small capacitance it cannot avoid. Driving that wire means charging that capacitance through the resistance of whatever is driving it. That delay is why logic gates are not instant, which is the subject of **propagation delay**, and ultimately why a processor has a **maximum clock speed**.
- A capacitor's insulator is never perfect. Charge slowly leaks across, and the capacitor forgets. A memory cell built from a tiny capacitor therefore has to be read and rewritten constantly to keep its value — which is exactly what **DRAM refresh** is, and why your computer's main memory is busy even when nothing is happening.

## What capacitors are actually used for

Four jobs cover almost everything.

**Smoothing.** Power supplies deliver bumpy voltage. A capacitor across the output charges at the peaks and discharges into the load through the dips, flattening it. It is a bucket under an unreliable tap.

**Decoupling.** When a chip suddenly starts switching, it demands a burst of current faster than the power supply across the board can respond. A small capacitor sitting right next to the chip supplies that burst locally. This is why boards are covered in 100 nF capacitors next to every chip — they are tiny local reservoirs, placed close because distance itself is a delay.

**Timing.** Charging through a known resistance takes a known time. That is the basis of every simple delay, oscillator and blinking light.

**Blocking DC while passing AC.** A steady voltage charges a capacitor once and then nothing more flows. A changing voltage keeps charging and discharging it, so current keeps moving. The capacitor passes the changing part of a signal and blocks the steady part — which is a genuinely useful thing to be able to separate.

## Inductors, briefly

There is a mirror image of the capacitor, and it is worth knowing about even though very little else in this track depends on it.

An **inductor** is a coil of wire. Current through a coil creates a magnetic field, and building that field takes energy and time.

Where a capacitor resists a change in *voltage*, an inductor resists a change in *current*. Switch an inductor on and current ramps up gradually rather than jumping. Switch it off and the collapsing magnetic field tries hard to keep the current going, which can produce a sharp voltage spike — the reason a circuit driving a motor or a relay needs a diode to absorb it.

Inductance is measured in **henries**, written H.

Inductors matter enormously in power conversion and radio. They matter much less in digital logic, which is where this track is heading, so this is the depth we need. The one thing worth carrying forward is the pairing: **a capacitor stores energy in an electric field between plates, an inductor stores it in a magnetic field around a coil**, and each resists sudden change in the quantity the other one doesn't.

## Where this leads

- A **capacitor** stores charge on two plates separated by an insulator, and passes no charge through itself.
- **Capacitance** (farads) is charge held per volt.
- Charging through a resistor follows one fixed curve, scaled by the **time constant τ = R × C**, reaching 63% at one τ and effectively full at five.
- That delay is unavoidable, exists in every wire and every chip input, and is the ultimate source of the speed limits later in this track.

There is one more thing to cover before leaving the analog world. So far every voltage has been steady, or has settled to steady. But the useful signals — the ones that carry information — are the ones that keep changing.

The next page is about how to describe a changing voltage, and about the difference between a signal that can be anything and a signal that is only ever allowed to be one of two things. That distinction is the border between analog and digital, and this track crosses it and does not come back.
