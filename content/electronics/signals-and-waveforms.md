# Signals & Waveforms

A steady voltage carries no information.

That sounds like a strange thing to say after four pages spent working out what voltage is. But think about what it would mean to receive a message from a wire held permanently at 3 volts. You look at it. It says 3 volts. You look again an hour later. Still 3 volts. Nothing has been communicated, because nothing has happened.

**Information lives in change.** A signal is a voltage that changes on purpose, and this page is about how to describe one — and about the single design decision that separates all the electronics before computers from everything after.

## Steady and changing

The first split is the oldest one in the subject.

**DC**, direct current, means a voltage that holds one value and one direction. A battery is DC. The supply rail feeding a chip is DC.

**AC**, alternating current, means a voltage that swings back and forth, repeatedly reversing direction. Mains electricity is AC, swinging 50 or 60 times a second depending on where you live.

The reason mains is AC is worth one sentence, because it is a nice payoff from the power formula. Transformers can raise and lower AC voltages very efficiently, and sending power at high voltage means low current, and current is what heats up cables. AC is what makes it practical to move power across a country without wasting most of it in the wires.

Everything inside a computer, by contrast, runs on DC — but on DC that is being switched on and off very rapidly, which is its own thing and the real subject here.

## Describing a repeating signal

Most useful signals repeat. Four numbers describe any repeating wave completely.

<div class="diagram-wrap">
<svg viewBox="0 0 620 260" width="620" height="260" role="img" aria-label="A sine wave annotated with its amplitude, period, peak-to-peak value and zero line">
  <line x1="50" y1="130" x2="570" y2="130" class="d-axis"></line>
  <text x="34" y="134" text-anchor="end" class="d-sym-note">0 V</text>
  <path d="M 60 130 Q 92 40 124 130 Q 156 220 188 130 Q 220 40 252 130 Q 284 220 316 130 Q 348 40 380 130 Q 412 220 444 130 Q 476 40 508 130 Q 540 220 556 168" class="d-msg d-request" fill="none"></path>
  <line x1="124" y1="70" x2="252" y2="70" class="d-marker-line"></line>
  <text x="188" y="62" text-anchor="middle" class="d-sym-value" font-size="11">period (T)</text>
  <line x1="124" y1="62" x2="124" y2="130" class="d-marker-line"></line>
  <line x1="252" y1="62" x2="252" y2="130" class="d-marker-line"></line>
  <line x1="348" y1="130" x2="348" y2="58" class="d-marker-line"></line>
  <text x="358" y="96" class="d-sym-value" font-size="11">amplitude</text>
  <line x1="540" y1="58" x2="540" y2="202" class="d-marker-line"></line>
  <text x="550" y="130" class="d-sym-value" font-size="11">peak</text>
  <text x="550" y="146" class="d-sym-value" font-size="11">to peak</text>
  <circle cx="124" cy="130" r="4" class="d-node"></circle>
  <circle cx="252" cy="130" r="4" class="d-node"></circle>
  <rect x="90" y="216" width="440" height="34" rx="8" class="d-note"></rect>
  <text x="310" y="238" text-anchor="middle" class="d-note-text" font-size="12">Frequency is just the period turned upside down: f = 1 / T.</text>
  <defs></defs>
</svg>
<div class="diagram-caption">One cycle, measured two ways. How far it swings is amplitude; how long one full repeat takes is the period.</div>
</div>

**Amplitude** is how far it swings from the centre. Often quoted instead as **peak-to-peak**, the full distance from the lowest point to the highest, which is what you actually see on an instrument.

**Period** is how long one complete cycle takes, in seconds.

**Frequency** is how many cycles happen per second, measured in **hertz** (Hz). It is simply one divided by the period. A signal repeating every millisecond runs at 1000 Hz.

**Phase** is where in its cycle the wave is at a given moment, compared to some other wave. On its own it means nothing; it only has meaning between two signals. Two signals perfectly in step are *in phase*. This matters a great deal later, when a clock signal has to arrive at different parts of a chip at the same moment.

Frequency prefixes are used constantly, and they are the same ones from page one:

| Written | Cycles per second | Where you meet it |
|---|---|---|
| 50 Hz | 50 | mains power |
| 44.1 kHz | 44,100 | audio sampling |
| 100 MHz | 100 million | a memory bus |
| 3.5 GHz | 3.5 billion | a processor clock |

That last row is worth pausing on. A 3.5 GHz clock has a period of about 0.29 nanoseconds. In that time, light travels about 9 cm. This is not a comfortable margin, and it is one of the reasons the last module of this track exists.

## The square wave

Sine waves are what nature produces. Computers use something else.

A **square wave** sits at one voltage, jumps to another, sits there, and jumps back. It spends nearly all its time at one of two values and almost no time in between.

This is the shape of every clock signal and every digital signal in existence, and the reason is the whole argument for digital, which comes at the end of this page.

A square wave has one extra property the sine wave does not: **duty cycle**, the fraction of each cycle it spends high. A 50% duty cycle is high half the time. 10% is a brief pulse with a long gap.

Duty cycle turns out to be a control mechanism, because of one useful fact — the *average* voltage of a square wave is the supply voltage times the duty cycle. Drag it.

<div class="diagram-wrap" data-calc>
<svg viewBox="0 0 600 280" width="600" height="280" role="img" aria-label="A square wave with an adjustable duty cycle, showing how the average voltage tracks the fraction of time spent high">
  <line x1="50" y1="180" x2="560" y2="180" class="d-axis"></line>
  <line x1="50" y1="60" x2="50" y2="180" class="d-axis"></line>
  <text x="40" y="66" text-anchor="end" class="d-sym-note">5 V</text>
  <text x="40" y="184" text-anchor="end" class="d-sym-note">0 V</text>
  <rect x="60" y="60" width="50" height="120" class="d-level" data-calc-attr="width" data-calc-expr="D"></rect>
  <rect x="160" y="60" width="50" height="120" class="d-level" data-calc-attr="width" data-calc-expr="D"></rect>
  <rect x="260" y="60" width="50" height="120" class="d-level" data-calc-attr="width" data-calc-expr="D"></rect>
  <rect x="360" y="60" width="50" height="120" class="d-level" data-calc-attr="width" data-calc-expr="D"></rect>
  <rect x="460" y="60" width="50" height="120" class="d-level" data-calc-attr="width" data-calc-expr="D"></rect>
  <rect x="50" y="119" width="510" height="2.5" class="d-plate" data-calc-attr="y" data-calc-expr="179-1.2*D"></rect>
  <text x="566" y="123" class="d-sym-value" font-size="11" data-calc-out="Vavg">2.5 V</text>
  <line x1="60" y1="200" x2="160" y2="200" class="d-marker-line"></line>
  <text x="110" y="216" text-anchor="middle" class="d-sym-note">one cycle</text>
  <text x="300" y="244" text-anchor="middle" class="d-sym-note">the dashed line is the average — what a slow device actually feels</text>
  <text x="300" y="264" text-anchor="middle" class="d-sym-note">the wave itself is still only ever fully on or fully off</text>
  <defs></defs>
</svg>
<script type="application/json" class="calc-spec">
{
"inputs": [
{"id": "D", "label": "Duty cycle", "min": 0, "max": 100, "step": 1, "value": 50, "unit": "%", "digits": 0}
],
"outputs": [
{"id": "Vavg", "label": "Average voltage", "expr": "5 * D / 100", "unit": "V", "digits": 2},
{"id": "bright", "label": "LED brightness", "expr": "D", "unit": "%", "digits": 0}
]
}
</script>
<div class="diagram-caption">The switch is only ever fully on or fully off, yet the average can be set to anything in between. This is how a dimmed light and a motor at half speed are actually driven.</div>
</div>

This technique is called **pulse-width modulation**, or PWM, and it is everywhere. Dimming an LED, setting a motor's speed, controlling a heater — all of them switch fully on and fully off very fast and vary the ratio.

The reason to do it this way rather than just supplying a lower voltage comes straight from the power page. A switch that is fully on has almost no voltage across it, and a switch that is fully off has almost no current through it. Power is voltage times current, so in both states the switch wastes almost nothing. Anything that sat in between would be burning the difference as heat.

## Edges are not vertical

Square waves are drawn with perfectly vertical sides. Real ones do not have them, and the last page explains why.

Every wire has capacitance. Every driver has resistance. Changing a wire's voltage means charging that capacitance through that resistance, and that follows the RC curve — which has no vertical parts anywhere.

So a real edge slopes. **Rise time** is how long the signal takes to get from low to high, conventionally measured between 10% and 90%.

<div class="diagram-wrap">
<svg viewBox="0 0 620 230" width="620" height="230" role="img" aria-label="An ideal square edge next to a real one that slopes, with rise time marked between the ten and ninety percent points">
  <text x="160" y="28" text-anchor="middle" class="d-label">Ideal</text>
  <text x="460" y="28" text-anchor="middle" class="d-label">Real</text>
  <line x1="50" y1="160" x2="280" y2="160" class="d-axis"></line>
  <path d="M 70 160 L 160 160 L 160 60 L 265 60" class="d-msg d-request" fill="none"></path>
  <text x="160" y="185" text-anchor="middle" class="d-sym-note">instant, and impossible</text>
  <line x1="340" y1="160" x2="580" y2="160" class="d-axis"></line>
  <path d="M 355 160 L 420 160 Q 450 160 462 130 Q 478 88 500 70 Q 520 60 565 60" class="d-msg d-request" fill="none"></path>
  <line x1="340" y1="70" x2="580" y2="70" class="d-marker-line"></line>
  <text x="332" y="74" text-anchor="end" class="d-sym-note">90%</text>
  <line x1="340" y1="150" x2="580" y2="150" class="d-marker-line"></line>
  <text x="332" y="154" text-anchor="end" class="d-sym-note">10%</text>
  <line x1="444" y1="150" x2="444" y2="196" class="d-marker-line"></line>
  <line x1="508" y1="70" x2="508" y2="196" class="d-marker-line"></line>
  <line x1="444" y1="196" x2="508" y2="196" class="d-msg d-request"></line>
  <text x="476" y="214" text-anchor="middle" class="d-sym-value" font-size="11">rise time</text>
  <defs></defs>
</svg>
<div class="diagram-caption">The RC curve from the previous page, appearing where it always appears. Nothing switches instantly, and how long it takes is what limits how fast a system can run.</div>
</div>

This is the constraint that eventually caps clock speed. A clock period has to be long enough for signals to finish getting where they are going and settle. Shorten the period past that point and the next cycle begins while the last one is still on its way.

## Noise, and why digital won

Now the decision that everything after this page rests on.

Real signals pick up **noise** — small unwanted voltages from nearby wires, power supplies, motors, radio, and the random thermal jitter of the electrons themselves. Noise is not a defect to be engineered away. It is always there.

Consider what that means for a signal where every voltage is meaningful. If 2.5 V means one thing and 2.6 V means another, then 0.1 V of noise has changed your message. Worse, every time you copy, amplify or send that signal onward, it picks up a bit more. Errors accumulate and cannot be removed, because nothing distinguishes the noise from the signal.

Now consider a signal that is only ever allowed to be **near 0 V or near 5 V**, with everything in between declared meaningless.

Add half a volt of noise to that and a 5 V signal becomes 4.5 V. Which is still obviously a 5. You round it back and the noise is *gone* — not reduced, gone. The original value is recovered exactly.

<div class="diagram-wrap">
<svg viewBox="0 0 620 250" width="620" height="250" role="img" aria-label="A noisy analog signal degrading versus a noisy two-level signal being restored to clean values">
  <text x="160" y="26" text-anchor="middle" class="d-label">Many valid levels</text>
  <text x="460" y="26" text-anchor="middle" class="d-label">Two valid levels</text>
  <path d="M 50 120 Q 72 66 96 104 Q 116 146 140 82 Q 160 42 184 118 Q 204 162 228 96 Q 250 60 272 128" class="d-msg d-request" fill="none"></path>
  <path d="M 50 122 Q 60 96 68 118 Q 76 70 84 100 Q 92 118 100 100 Q 110 140 118 120 Q 126 88 134 84 Q 142 60 150 90 Q 158 44 166 72 Q 174 112 182 114 Q 190 158 198 140 Q 206 108 214 118 Q 222 90 230 100 Q 238 56 246 74 Q 254 108 262 120 Q 268 128 272 130" class="d-wire"></path>
  <text x="160" y="186" text-anchor="middle" class="d-sym-note">Every level means something, so</text>
  <text x="160" y="203" text-anchor="middle" class="d-sym-note">every wobble corrupts the message.</text>
  <text x="160" y="220" text-anchor="middle" class="d-sym-note">Copy it again and it gets worse.</text>
  <line x1="340" y1="60" x2="580" y2="60" class="d-marker-line"></line>
  <text x="588" y="64" class="d-sym-note">1</text>
  <line x1="340" y1="150" x2="580" y2="150" class="d-marker-line"></line>
  <text x="588" y="154" class="d-sym-note">0</text>
  <path d="M 344 148 Q 352 156 360 144 L 380 146 L 382 64 Q 390 54 398 66 L 420 58 L 422 148 Q 432 158 440 142 L 462 150 L 464 62 Q 474 52 482 68 L 500 60 L 502 150 Q 512 142 520 156 L 540 148 L 542 60 Q 552 68 560 56 L 574 62" class="d-wire"></path>
  <path d="M 344 150 L 382 150 L 382 60 L 422 60 L 422 150 L 464 150 L 464 60 L 502 60 L 502 150 L 542 150 L 542 60 L 574 60" class="d-msg d-request" fill="none"></path>
  <text x="460" y="186" text-anchor="middle" class="d-sym-note">The same noise arrives, and lands</text>
  <text x="460" y="203" text-anchor="middle" class="d-sym-note">nowhere near the halfway mark.</text>
  <text x="460" y="220" text-anchor="middle" class="d-sym-note">Round it off and the original is back.</text>
  <defs></defs>
</svg>
<div class="diagram-caption">The same amount of noise on both. On the left it is indistinguishable from the message. On the right it is obviously not one of the two permitted answers, so it can be thrown away.</div>
</div>

That is the trade, stated plainly: **you give up the ability to represent every possible value, and in exchange you get the ability to remove noise completely.**

It is a bad deal for a small number of copies and an overwhelmingly good one for a large number. A signal that crosses a chip, goes down a wire, is stored, retrieved, and copied a billion times arrives bit-for-bit identical. Nothing analog can do that.

This is why music is stored as numbers, why the photo does not fade, and why a processor can perform billions of operations in sequence without the answer slowly turning to mush.

The world itself is analog — sound, light, temperature and pressure are all continuous. So real systems convert at the edges. An **ADC** (analog-to-digital converter) measures a voltage and reports a number; a **DAC** goes the other way. Everything between those two conversions is digital, on purpose.

## Where this leads

- A **signal** carries information by changing; a steady voltage says nothing.
- Repeating signals are described by **amplitude, period, frequency and phase**.
- A **square wave** spends its time at two levels, and its **duty cycle** sets its average — which is how digital switching controls analog-seeming things.
- Real edges slope, because of the **RC delay** that is unavoidable in every wire.
- Restricting a signal to **two levels** makes noise removable, and that one decision is the foundation of all digital electronics.

Module 1 is done. You now have charge, current, voltage, resistance, power, series and parallel circuits, capacitance, time constants, and the argument for two-level signalling.

What is still missing is a component that can *do* the switching. Everything so far has been passive — resistors and capacitors respond to what they are given and can never amplify or control anything. Building a two-level signal needs something that can be commanded: a device where a voltage at one terminal decides whether current flows between two others.

No arrangement of resistors and capacitors can do that. It needs a material that is neither a conductor nor an insulator, but can be persuaded to be either.
