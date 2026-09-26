# Contract change proposals — WP6

## 2026-09-25 — PROP_AUX aux.x = per-part roughness override (documentation of an implemented extension)
- **WP:** WP6
- **Change:** doc comment only, `src/core/ids.ts` VFlag.PROP_AUX:
  `PROP_AUX: 128, // brAux = (roughness override byte (0 = none, else roughness = x / 255), 0, bits: 1 = tower-periodic, ceilCm/5 of the anchor cell)`
  and §5 WP6 "Materials per part": `aux = (roughOverride, 0, bits, ceilByte)`.
- **Rationale:** the spec asks for part-level gloss the layer table cannot express (CRT glass "roughness 0.1", car
  paint, chrome tubes, glossy jugs/bottles). src/props/builder.ts writes `aux.x = round(rough * 255)` (>= 1) for such
  parts and 0 otherwise; WP9 already honours it (see WP9.md, 2026-09-24). With aux.x = 0 the behaviour is the
  frozen contract's.
- **Consumers affected:** WP9 (implemented). No other reader of PROP_AUX aux.x.

## 2026-09-25 — Geometry conventions other WPs place against (implementation notes, no type change)
- **WP:** WP6
- **Change:** none to types. Conventions of the prop local frames that generators must follow:
  - VENDING fixture + VENDING_MACHINE: the machine's window is 0.72 x 1.42 centred at local (0, 1.05) on its front
    (local z = -0.37, frame proud to -0.39). The VENDING fixture (RECT 0.7 x 1.4, n = machine front) is drawn with its
    lit panel 3.2 cm behind the fixture centre, so the fixture centre belongs on the machine front +0.5..+4 cm, at
    y = base + 1.05 (vendingAlcove does this; WP2 office.ts uses y = 1.0, a 5 cm offset, see the WP6 report).
  - PIPE_VALVE: pipe axis along local x at local y = 0.15 (p.y = pipeCentreY - 0.15), flanges r 0.074 (sized for
    pipes r <= 0.07; use `scale` for bigger pipes).
  - POOL_LADDER: deck (coping) at local y = 1.0..1.1 (p.y = deckY - 1.0, or the pool floor clamped to -1.1).
  - FLOAT_ROPE: floats centred at local y = 0.06 (p.y = waterY - 0.06); rope along local x, 1.17 m.
  - Wall-mounted kinds have their back plane on local +Z = size.z / 2.
  - CAR_SEDAN variant 3 (driver door open): the body is 1.48 m wide instead of 1.64 m so the open door stays inside
    the 1.8 m PROP_DEFS footprint.
- **Rationale:** these are not expressible in PROP_DEFS; recorded so placement (WP3/WP4) and geometry agree.
- **Consumers affected:** WP2, WP3, WP4 (placement), WP12 (collision uses PROP_DEFS only: unaffected).
