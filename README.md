# eevee-threejs

A small, dependency-light reimplementation of **Blender/Eevee's lighting + view-transform
pipeline** for Three.js custom shaders. It ports the three things Eevee does "for free"
that hand-written WebGL shaders usually fake:

1. **Sun (directional) diffuse** — color + strength, like a Blender Sun light.
2. **A gradient-sky world**, sampled as **diffuse hemisphere irradiance** — the thing that
   gives sky-lit undersides their color instead of crushing to black.
3. **A "Shader to RGB"-style diffuse response** + a **view transform**
   (Standard / Filmic / AgX) + the display (sRGB) encode, matching Blender's color
   management: `eeveeView()` returns the final on-screen color.

It is **not** a full PBR renderer. It ports the specific, extremely common Eevee setup of
*"one sun + a colored/gradient world + Filmic"* into reusable GLSL chunks you compose into
your own `ShaderMaterial`.

## Live demos

- **[Lit Primitives](https://tatimblin.github.io/eevee-threejs/examples/primitives/)** — sphere + torus-knot, live view-transform switch
- **[Painterly Cloud](https://tatimblin.github.io/eevee-threejs/examples/cloud/)** — billboard cloud with a procedurally-generated brush atlas
- **[Landing page](https://tatimblin.github.io/eevee-threejs/)**

Drag to orbit in either demo.

## Why this exists

Porting a Blender look to the web, people usually copy the *material* nodes and get a flat,
wrong result — because half the look lives in the **world lighting and the view transform**,
not the material. This library is that missing half, as a drop-in.

## Install / use

No build step. Copy `src/eevee.js` into your project (or import it directly). Requires
`three` r152+ (for `renderer.outputColorSpace`) with color management on; the examples
use r160.

```js
import * as THREE from 'three';
import { EEVEE_GLSL, EeveeEnv, mergeUniforms } from './eevee.js';

THREE.ColorManagement.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;  // eeveeView() encodes to this
renderer.toneMapping = THREE.NoToneMapping;        // eeveeView() tonemaps in-shader

const env = new EeveeEnv({
  sunColor: '#fff2d0', sunStrength: 2.2,
  skyHorizon: '#9cc0ec', skyZenith: '#1f3f9c',
  skyStrength: 0.8, ambient: 0.35, exposure: 1.2, view: 'AgX',
  azimuth: 50, elevation: 55,
});

const material = new THREE.ShaderMaterial({
  uniforms: mergeUniforms(env.uniforms, { uAlbedo: { value: new THREE.Color('#c85a3c') } }),
  vertexShader: `
    varying vec3 vN;
    void main(){ vN = normalize(mat3(modelMatrix)*normal);
      gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    precision highp float;
    ${EEVEE_GLSL}
    uniform vec3 uAlbedo; varying vec3 vN;
    void main(){
      vec3 lit = eeveeShadeDiffuse(normalize(vN), uAlbedo);
      gl_FragColor = vec4(eeveeView(lit), 1.0);   // exposure + view transform + sRGB encode
    }`,
});
```

Call `env.sync()` after changing any field, or wire a `lil-gui` folder with
`env.addGUI(gui.addFolder('Eevee'))`.

## GLSL API (from `EEVEE_GLSL`)

| Function | Purpose |
|---|---|
| `vec3 eeveeSky(vec3 dir)` | World/environment radiance looking along `dir` |
| `vec3 eeveeSkyIrradiance(vec3 N)` | Diffuse hemisphere irradiance for normal `N` |
| `vec3 eeveeSunDiffuse(vec3 N)` | Sun Lambert term |
| `vec3 eeveeShadeDiffuse(vec3 N, vec3 albedo)` | Full diffuse: `albedo * (sun + sky)` |
| `vec3 eeveeTonemap(vec3 linear)` | Exposure + view transform (Standard/Filmic/AgX). Returns display-**linear** color in [0,1], **not** encoded |
| `vec3 eeveeView(vec3 linear)` | `eeveeTonemap` + output encode. Returns the **final display color** for `gl_FragColor` |

`EEVEE_GLSL` is a fragment-shader chunk for `THREE.ShaderMaterial`. For
`RawShaderMaterial` or vertex shaders, see the opt-out below.

## Color management

three.js never encodes a `ShaderMaterial`'s output by itself. `gl_FragColor` reaches the
canvas as-is unless the shader calls three's `linearToOutputTexel()`, which is all that
`#include <colorspace_fragment>` does. `eeveeView()` makes that call. It runs Blender's
whole chain: **exposure → view transform → display encode**.

- **The encode follows `renderer.outputColorSpace`.** On a normal canvas it is sRGB.
  Inside a render target three switches it to linear, so post-processing still gets
  linear values and the final pass (e.g. `OutputPass`) encodes once.
- **Working after the view transform** (grading, fog, compositing): use
  `eeveeTonemap()` and encode once at the end with
  `gl_FragColor = linearToOutputTexel(vec4(color, alpha));`.
- **Opt-out, `EEVEE_LINEAR_OUTPUT`:** define it and `eeveeView()` returns
  `eeveeTonemap()`'s display-linear color without encoding. Define it in the shader
  above `${EEVEE_GLSL}`, or with `defines: { EEVEE_LINEAR_OUTPUT: '' }`. You need it:
  - when your shader does `#include <colorspace_fragment>` itself (otherwise the color
    is encoded twice);
  - in `RawShaderMaterial` and vertex shaders, where three does not define
    `linearToOutputTexel`. Without the define they fail to compile with
    *"'linearToOutputTexel' : no matching overloaded function found"*. With it, the
    encode is up to you.
- **AgX:** the AgX approximation is shaped in display-encoded space, like real AgX's
  sigmoid. `eeveeTonemap()` therefore decodes it to linear, and the encode gives it back
  exactly: on screen, AgX looks the same as before the fix.

### Migrating from the un-encoded `eeveeView()`

Up to commit `58c3c69`, `eeveeView()` skipped the display encode. It said "renderer
encodes sRGB", but three never encodes a `ShaderMaterial`. So Standard and Filmic output
reached the screen un-encoded: midtones came out dark, muddy and flat. With the fix,
existing Standard/Filmic scenes get **brighter**, most of all in the midtones and
shadows. AgX scenes do not change.

**Rule of thumb.** Lower exposure to compensate, then re-check palettes. To keep a pixel
at the on-screen level it used to show, multiply exposure by the factor for that level.
Mid-grey (#808080) is the usual target. The factors were measured by GPU readback on
three r160:

| View | keeps 25% grey | keeps **50% grey** | keeps 75% grey |
|---|---|---|---|
| Filmic | ×0.17 | **×0.32** (−1.7 stops) | ×0.49 |
| Standard | ×0.20 | **×0.43** (−1.2 stops) | ×0.70 |
| AgX | ×1 | **×1** (unchanged) | ×1 |

No single exposure brings the old look back. The old output had an extra ~2.2 gamma
of contrast baked in. At the mid-grey setting, shadows stay lighter than before and
highlights come out a little dimmer: under Filmic, a pixel that showed at 10% now shows
at 20%, and 90% becomes 76%. Colors chosen to look right un-encoded now come out lighter
and less saturated, so re-pick them by eye.

If a scene only looked muddy *because* of the missing encode, don't preserve that look.
Retune it by eye instead. The cloud example's exposure went **up**, from 1.4 to 2.0. It
also stopped clamping its sunlit color to 1.0 before the view transform, since Filmic's
shoulder is there to roll those values off.

### How close is it to Blender?

Measured against Blender 5.1 (sRGB display, look None, exposure 0), 18% grey shows as:

| View | Blender | eevee-threejs (exposure 1) |
|---|---|---|
| Standard | 0.46 | 0.46 (exact) |
| Filmic | 0.50 | 0.29 |
| AgX | 0.46 | 0.62 |

- **Filmic** is a Hable/Uncharted-2 stand-in, darker in the midtones than Blender's
  Filmic. Exposure ≈3.6 matches Blender's mid-grey, but highlights then clip about 2.4
  stops sooner.
- **AgX** is an approximation about one stop brighter than Blender's AgX at mid-grey.
  Exposure ≈0.5 matches it.

## JS API (`EeveeEnv`)

Fields: `sunColor, sunStrength, skyHorizon, skyZenith, skyStrength, skyGradient, ambient,
exposure, view ('Standard'|'Filmic'|'AgX'), azimuth, elevation`.

Methods: `sync()` (push fields → uniforms), `sunDirection()`, `backgroundColor(hex)`
(Blender's "Is Camera Ray" trick — light with the sky but show a flat background),
`addGUI(folder)`.

## Examples

Run live (above) or locally. ES modules + import maps need an HTTP server — opening the
HTML over `file://` will not work:

```
python3 -m http.server      # from the repo root, then open:
#  http://localhost:8000/examples/primitives/   — lit sphere + torus-knot, view-transform switch
#  http://localhost:8000/examples/cloud/        — painterly billboard cloud (procedural brush atlas)
```

Both examples pull Three.js from a CDN via an import map — no install needed.

## Background & attribution

The **stylized cloud technique** demonstrated in `examples/cloud` (camera-facing billboard
cards + baked form normals + an NPR grade) was inspired by **Rei (@reipart_)**'s excellent
"Stylized Cloud Generator" Blender tool. That is a **paid, commercial product** — go buy it
if you want the real thing.

**This repository contains none of Rei's assets or data.** No textures, no `.blend` files,
no extracted node values, no parameter presets from the tool. The brush-stroke atlas in the
cloud example is generated procedurally on a `<canvas>` at runtime, and the environment
lighting (this library's actual subject) is a generic Blender/Eevee reimplementation, not
specific to any product. Nothing here reproduces the paid tool.

This project exists because, while studying how such a look is built, the **lighting +
view-transform half** turned out to be reusable and completely Blender-agnostic — so it was
extracted into this standalone, asset-free library.

Two things a Blender→web port must add that Blender handles implicitly, both shown in the
cloud example:
- **Drive shadow gradients from a smooth form normal**, not per-primitive normals, so the
  shading reads as one coherent mass.
- **Front-shell culling** for transparent billboard shells, so back/interior cards don't
  bleed their shadow side through the front.

## License

MIT © 2026. Contains no third-party or paid assets.
