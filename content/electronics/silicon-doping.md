# Why Silicon? Doping & Semiconductors

The last page ended with a demand that nothing so far can meet.

Resistors and capacitors are **passive**. They react to what they are given. A resistor cannot decide to stop conducting, and a capacitor cannot be told to let current past. Neither can be *commanded*.

Building a digital system needs a component that can. Something with a control terminal — where a voltage in one place decides whether current flows somewhere else.

That requires a material that is neither a good conductor nor a good insulator, but sits between the two and can be pushed either way. That material is a **semiconductor**, and almost always it is silicon.

## The middle ground

Recall the split from the first page. Metals conduct because they are full of loose electrons. Insulators do not conduct because every electron is locked to its atom.

Silicon sits between. In its pure form it is a poor conductor — but unlike an insulator, it is poor for a reason that can be interfered with.

A silicon atom has **four outer electrons**. Four is exactly half of the eight that make an atom's outer shell comfortable, and this is the whole reason silicon behaves as it does.

In a silicon crystal, every atom shares each of its four electrons with a neighbour, and borrows one back from each. Every atom ends up with eight shared electrons. Every electron is committed to a bond.

<div class="diagram-wrap">
<svg viewBox="0 0 620 280" width="620" height="280" role="img" aria-label="A silicon crystal lattice where every atom shares four electrons with its neighbours, leaving none free to move">
  <line x1="160" y1="76" x2="310" y2="76" class="d-sym"></line>
  <line x1="160" y1="84" x2="310" y2="84" class="d-sym"></line>
  <line x1="310" y1="76" x2="460" y2="76" class="d-sym"></line>
  <line x1="310" y1="84" x2="460" y2="84" class="d-sym"></line>
  <line x1="160" y1="186" x2="310" y2="186" class="d-sym"></line>
  <line x1="160" y1="194" x2="310" y2="194" class="d-sym"></line>
  <line x1="310" y1="186" x2="460" y2="186" class="d-sym"></line>
  <line x1="310" y1="194" x2="460" y2="194" class="d-sym"></line>
  <line x1="156" y1="80" x2="156" y2="190" class="d-sym"></line>
  <line x1="164" y1="80" x2="164" y2="190" class="d-sym"></line>
  <line x1="306" y1="80" x2="306" y2="190" class="d-sym"></line>
  <line x1="314" y1="80" x2="314" y2="190" class="d-sym"></line>
  <line x1="456" y1="80" x2="456" y2="190" class="d-sym"></line>
  <line x1="464" y1="80" x2="464" y2="190" class="d-sym"></line>
  <circle cx="160" cy="80" r="27" class="d-sym-body"></circle>
  <text x="160" y="85" text-anchor="middle" class="d-sym-label">Si</text>
  <circle cx="310" cy="80" r="27" class="d-sym-body"></circle>
  <text x="310" y="85" text-anchor="middle" class="d-sym-label">Si</text>
  <circle cx="460" cy="80" r="27" class="d-sym-body"></circle>
  <text x="460" y="85" text-anchor="middle" class="d-sym-label">Si</text>
  <circle cx="160" cy="190" r="27" class="d-sym-body"></circle>
  <text x="160" y="195" text-anchor="middle" class="d-sym-label">Si</text>
  <circle cx="310" cy="190" r="27" class="d-sym-body"></circle>
  <text x="310" y="195" text-anchor="middle" class="d-sym-label">Si</text>
  <circle cx="460" cy="190" r="27" class="d-sym-body"></circle>
  <text x="460" y="195" text-anchor="middle" class="d-sym-label">Si</text>
  <text x="530" y="84" class="d-sym-note">each pair of lines</text>
  <text x="530" y="100" class="d-sym-note">is two shared</text>
  <text x="530" y="116" class="d-sym-note">electrons</text>
  <rect x="90" y="238" width="440" height="34" rx="8" class="d-note"></rect>
  <text x="310" y="260" text-anchor="middle" class="d-note-text" font-size="12">Every electron has a job. Nothing is free to drift, so pure silicon barely conducts.</text>
  <defs></defs>
</svg>
<div class="diagram-caption">A perfect silicon crystal is a fully booked structure. There is no shortage of electrons — there is a shortage of <em>available</em> ones.</div>
</div>

So pure silicon conducts badly. Not because it lacks electrons, but because all of them are already committed.

This is the important difference from an insulator. Those bonds are not held all that tightly. Warm the crystal, shine light on it, or apply enough voltage, and a few electrons break loose. Silicon's conductivity can be *changed* — and that is the opening.

## Doping

Pure silicon is not directly useful. What makes it useful is deliberately ruining it.

**Doping** means adding a tiny, precisely controlled quantity of a different element into the crystal — roughly one atom in ten million. That sounds far too small to matter. It changes the material's conductivity by a factor of thousands.

There are two kinds, and they are mirror images.

### n-type: a spare electron

Add an atom with **five** outer electrons — phosphorus is the usual choice.

It sits in the crystal where a silicon atom would have been and forms four bonds with its neighbours, exactly as expected. But it brought five electrons. The fifth has nothing to bond with.

That fifth electron is loosely held and easily knocked free. It becomes a **free electron**, able to drift when a voltage pushes.

Silicon doped this way is **n-type**, n for negative — the moving charges are negative electrons.

### p-type: a missing electron

Now add an atom with **three** outer electrons instead. Boron is the usual choice.

It can only form three bonds. The fourth bond position has no electron in it. There is a gap.

That gap is called a **hole**, and it is where the idea gets slightly odd but genuinely useful.

A neighbouring bonded electron can hop sideways into the hole. Doing so fills that gap and leaves a new gap where it came from. Another electron hops into *that* one, and so on.

What you see, watching the material as a whole, is the *gap* travelling — in the opposite direction to the electrons. And because a gap is a place where a negative charge is missing, it behaves in every respect like a **positive charge moving**.

Silicon doped this way is **p-type**, p for positive.

<div class="diagram-wrap">
<svg viewBox="0 0 620 300" width="620" height="300" role="img" aria-label="n-type silicon with a spare free electron from phosphorus, next to p-type silicon with a hole from boron">
  <text x="160" y="28" text-anchor="middle" class="d-label">n-type — doped with phosphorus</text>
  <text x="460" y="28" text-anchor="middle" class="d-label">p-type — doped with boron</text>
  <line x1="160" y1="60" x2="160" y2="105" class="d-sym"></line>
  <line x1="160" y1="175" x2="160" y2="215" class="d-sym"></line>
  <line x1="85" y1="140" x2="128" y2="140" class="d-sym"></line>
  <line x1="192" y1="140" x2="235" y2="140" class="d-sym"></line>
  <circle cx="160" cy="48" r="16" class="d-sym-body"></circle>
  <text x="160" y="53" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="160" cy="228" r="16" class="d-sym-body"></circle>
  <text x="160" y="233" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="70" cy="140" r="16" class="d-sym-body"></circle>
  <text x="70" y="145" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="250" cy="140" r="16" class="d-sym-body"></circle>
  <text x="250" y="145" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="160" cy="140" r="32" class="d-sym-body is-accent"></circle>
  <text x="160" y="146" text-anchor="middle" class="d-sym-label">P</text>
  <circle cx="212" cy="98" r="7" class="d-block d-block-request"></circle>
  <path d="M 222 92 L 250 76" class="d-msg d-request" marker-end="url(#arrowS1)"></path>
  <text x="258" y="74" class="d-sym-value" font-size="11">free to move</text>
  <text x="160" y="270" text-anchor="middle" class="d-sym-note">Five electrons, four bonds.</text>
  <text x="160" y="287" text-anchor="middle" class="d-sym-note">One is left over.</text>
  <line x1="460" y1="60" x2="460" y2="105" class="d-sym"></line>
  <line x1="460" y1="175" x2="460" y2="215" class="d-sym"></line>
  <line x1="385" y1="140" x2="428" y2="140" class="d-sym"></line>
  <circle cx="460" cy="48" r="16" class="d-sym-body"></circle>
  <text x="460" y="53" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="460" cy="228" r="16" class="d-sym-body"></circle>
  <text x="460" y="233" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="370" cy="140" r="16" class="d-sym-body"></circle>
  <text x="370" y="145" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="550" cy="140" r="16" class="d-sym-body"></circle>
  <text x="550" y="145" text-anchor="middle" class="d-sym-note">Si</text>
  <circle cx="460" cy="140" r="32" class="d-sym-body is-accent"></circle>
  <text x="460" y="146" text-anchor="middle" class="d-sym-label">B</text>
  <circle cx="506" cy="140" r="8" class="d-node-open"></circle>
  <text x="524" y="126" class="d-sym-value" font-size="11">a hole</text>
  <path d="M 534 140 L 506 140" class="d-msg d-request" stroke-dasharray="3 3"></path>
  <text x="460" y="270" text-anchor="middle" class="d-sym-note">Three electrons, four bond slots.</text>
  <text x="460" y="287" text-anchor="middle" class="d-sym-note">One slot stays empty.</text>
  <defs>
    <marker id="arrowS1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">The same crystal, spoiled two different ways. One has a charge carrier too many; the other has a vacancy that behaves exactly like a positive carrier.</div>
</div>

One point that trips people up, so it is worth stating outright:

**Neither n-type nor p-type silicon is electrically charged.** Both are perfectly neutral. A phosphorus atom brought an extra electron, but it also brought an extra proton in its nucleus to match. The charges balance exactly.

What doping changes is not the *amount* of charge. It is the number of charge carriers **free to move**.

## Why silicon in particular

Several elements are semiconductors. Silicon dominates for reasons that are mostly practical rather than deep.

**It is everywhere.** Silicon is the second most abundant element in the Earth's crust. Sand is largely silicon dioxide. The raw material costs almost nothing.

**Its oxide is excellent.** This is the decisive one. Heat silicon in oxygen and it grows a layer of silicon dioxide — an outstanding insulator — directly on its surface, tightly bonded and easy to control. Almost every transistor on this page's horizon depends on having a thin, reliable insulator in exactly the right place, and silicon grows its own. Germanium, which the earliest transistors used, does not, which is largely why it lost.

**It works at the right temperatures.** Silicon's bonds are strong enough that heat does not knock large numbers of electrons loose at everyday temperatures, and weak enough that doping works. Germanium leaks badly when warm.

**It can be made extraordinarily pure and grown as a single crystal.** Modern silicon is refined to around one impurity atom in a billion, then grown into one continuous crystal the width of a dinner plate. You cannot dope a material precisely unless you start from something clean.

It is a strange list — the reason your computer exists is partly that sand is cheap and silicon rusts in a convenient way.

## Putting the two together

Neither type is interesting alone. Both are just mediocre conductors.

Everything happens at the boundary where a piece of p-type meets a piece of n-type. That boundary is a **pn junction**, and it is the foundation of every semiconductor device there is.

Here is what happens the moment they meet.

The n-side is crowded with free electrons. The p-side has holes. At the boundary, free electrons wander across into the p-side and drop into holes, and both vanish as mobile carriers.

That leaves a thin region at the boundary with no free carriers left in it at all. This is the **depletion region**.

And now something important happens. Those atoms are no longer balanced. On the n-side, atoms that lost an electron are left positively charged and *fixed in place* — they are part of the crystal and cannot move. On the p-side, atoms that gained one are fixed and negative.

So a voltage builds across that thin region. And it points in the direction that *opposes* any further electrons crossing.

<div class="diagram-wrap">
<svg viewBox="0 0 620 280" width="620" height="280" role="img" aria-label="A pn junction showing electrons and holes recombining at the boundary, leaving a depletion region with a built-in voltage across it">
  <rect x="60" y="60" width="230" height="120" class="d-sym-body"></rect>
  <rect x="330" y="60" width="230" height="120" class="d-sym-body"></rect>
  <rect x="290" y="60" width="40" height="120" class="d-note"></rect>
  <text x="150" y="48" text-anchor="middle" class="d-label">p-type</text>
  <text x="470" y="48" text-anchor="middle" class="d-label">n-type</text>
  <text x="310" y="48" text-anchor="middle" class="d-sym-value" font-size="11">depletion</text>
  <circle cx="100" cy="90" r="7" class="d-node-open"></circle>
  <circle cx="150" cy="120" r="7" class="d-node-open"></circle>
  <circle cx="200" cy="90" r="7" class="d-node-open"></circle>
  <circle cx="120" cy="150" r="7" class="d-node-open"></circle>
  <circle cx="240" cy="140" r="7" class="d-node-open"></circle>
  <circle cx="180" cy="160" r="7" class="d-node-open"></circle>
  <circle cx="380" cy="90" r="6" class="d-block d-block-request"></circle>
  <circle cx="430" cy="120" r="6" class="d-block d-block-request"></circle>
  <circle cx="480" cy="90" r="6" class="d-block d-block-request"></circle>
  <circle cx="400" cy="150" r="6" class="d-block d-block-request"></circle>
  <circle cx="520" cy="140" r="6" class="d-block d-block-request"></circle>
  <circle cx="460" cy="160" r="6" class="d-block d-block-request"></circle>
  <text x="272" y="86" text-anchor="middle" class="d-sym-label" font-size="15">−</text>
  <text x="272" y="116" text-anchor="middle" class="d-sym-label" font-size="15">−</text>
  <text x="272" y="146" text-anchor="middle" class="d-sym-label" font-size="15">−</text>
  <text x="272" y="176" text-anchor="middle" class="d-sym-label" font-size="15">−</text>
  <text x="348" y="86" text-anchor="middle" class="d-sym-label" font-size="15">+</text>
  <text x="348" y="116" text-anchor="middle" class="d-sym-label" font-size="15">+</text>
  <text x="348" y="146" text-anchor="middle" class="d-sym-label" font-size="15">+</text>
  <text x="348" y="176" text-anchor="middle" class="d-sym-label" font-size="15">+</text>
  <path d="M 350 205 L 270 205" class="d-msg d-request" marker-end="url(#arrowS2)"></path>
  <text x="310" y="228" text-anchor="middle" class="d-sym-value" font-size="11">built-in barrier, about 0.7 V</text>
  <text x="310" y="246" text-anchor="middle" class="d-sym-note">fixed charges, locked in the crystal</text>
  <text x="150" y="200" text-anchor="middle" class="d-sym-note">holes (mobile)</text>
  <text x="470" y="200" text-anchor="middle" class="d-sym-note">electrons (mobile)</text>
  <text x="310" y="266" text-anchor="middle" class="d-sym-note">it opposes any further crossing — and that is the whole trick</text>
  <defs>
    <marker id="arrowS2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="d-arrow-request"></path>
    </marker>
  </defs>
</svg>
<div class="diagram-caption">Carriers cancel each other out near the boundary and leave behind fixed, charged atoms. The voltage those create is the barrier every semiconductor device is built around.</div>
</div>

The process is self-limiting. Each electron that crosses makes the barrier slightly stronger, until it is strong enough to stop any more crossing. For silicon it settles at roughly **0.7 volts**, and that number will keep reappearing.

So a pn junction, left alone, has a built-in electrical barrier across it that nobody applied.

The interesting question is what happens when you apply a voltage from outside — pushing *with* the barrier, or *against* it. The answer is completely different in the two directions, and a component that behaves differently depending on which way you push it is the first genuinely new thing in this track.

## Where this leads

- A **semiconductor** conducts poorly in pure form, but its conductivity can be changed deliberately — unlike a conductor or an insulator.
- **Silicon** has four outer electrons, so a pure crystal commits every electron to a bond and leaves none free.
- **Doping** adds a trace of another element: phosphorus leaves a spare electron (**n-type**), boron leaves a **hole** that behaves as a mobile positive charge (**p-type**).
- Both types remain electrically **neutral**. Doping changes how many carriers can move, not how much charge is present.
- Where p meets n, carriers cancel and leave a **depletion region** with a built-in barrier of about **0.7 V**.

The next page takes a single pn junction and puts a voltage across it both ways. That gives the diode — a component that conducts in one direction and blocks the other.

The page after that adds a control terminal to the idea, and that gives the MOSFET: a switch with no moving parts, operated by voltage alone. Everything else in this track is built out of that one device.
