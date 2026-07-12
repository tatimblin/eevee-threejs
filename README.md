# eevee-threejs

A small, dependency-light reimplementation of **Blender/Eevee's lighting + view-transform
pipeline** for Three.js custom shaders. It ports the three things Eevee does "for free"
that hand-written WebGL shaders usually fake:

1. **Sun (directional) diffuse** — color + strength, like a Blender Sun light.
2. **A gradient-sky world**, sampled as **diffuse hemisphere irradiance** — the thing that
   gives sky-lit undersides their color instead of crushing to black.
3. **A "Shader to RGB"-style diffuse response** + a **view transform**
   (Standard / Filmic / AgX) + sRGB encode, matching Blender's color management.

It is **not** a full PBR renderer. It ports the specific, extremely common Eevee setup of
*"one sun + a colored/gradient world + Filmic"* into reusable GLSL chunks you compose into
your own `ShaderMaterial`.

![primitives](docs/primitives.png)
![cloud](docs/cloud.png)

## Why this exists

Porting a Blender look to the web, people usually copy the *material* nodes and get a flat,
wrong result — because half the look lives in the **world lighting and the view transform**,
not the material. This library is that missing half, as a drop-in.

## Install / use

No build step. Copy `src/eevee.js` into your project (or import it directly). Requires
`three` (r150+) with color management on.

```js
import * as THREE from 'three';
import { EEVEE_GLSL, EeveeEnv, mergeUniforms } from './eevee.js';

THREE.ColorManagement.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;   // we tonemap in-shader

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
      gl_FragColor = vec4(eeveeView(lit), 1.0);   // returns LINEAR; renderer encodes sRGB
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
| `vec3 eeveeView(vec3 linear)` | Exposure + view transform (Standard/Filmic/AgX), returns **linear** |

## JS API (`EeveeEnv`)

Fields: `sunColor, sunStrength, skyHorizon, skyZenith, skyStrength, skyGradient, ambient,
exposure, view ('Standard'|'Filmic'|'AgX'), azimuth, elevation`.

Methods: `sync()` (push fields → uniforms), `sunDirection()`, `backgroundColor(hex)`
(Blender's "Is Camera Ray" trick — light with the sky but show a flat background),
`addGUI(folder)`.

## Examples

```
python3 -m http.server      # from the repo root, then open:
#  examples/primitives/     — lit sphere + torus-knot, live view-transform switch
#  examples/cloud/          — painterly billboard cloud (procedural brush atlas)
```

Both examples pull Three.js from a CDN via an import map — no install needed.

## Background

This started as a reverse-engineering of a Blender Geometry-Nodes cloud tool. The lighting
half turned out to be reusable and Blender-agnostic, so it was extracted here. The cloud
example is an **original** re-creation (procedurally generated brush atlas, no third-party
assets) that demonstrates consuming the module.

Two things a Blender→web port must add that Blender handles implicitly, both shown in the
cloud example:
- **Drive shadow gradients from a smooth form normal**, not per-primitive normals, so the
  shading reads as one coherent mass.
- **Front-shell culling** for transparent billboard shells, so back/interior cards don't
  bleed their shadow side through the front.

## License

MIT © 2026. Contains no third-party or paid assets.
