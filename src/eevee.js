// eevee-threejs — a small, dependency-light reimplementation of Blender/Eevee's
// lighting + view-transform pipeline for Three.js custom ShaderMaterials.
//
// It gives you GLSL chunks (and matching uniforms) for the three things Eevee
// does "for free" that hand-written WebGL shaders usually fake:
//
//   1. Sun (directional) diffuse lighting with color/strength.
//   2. A GRADIENT-SKY WORLD, sampled as diffuse hemisphere irradiance — the thing
//      that gives sky-lit undersides their color instead of going black.
//   3. A "Shader to RGB" style diffuse response + a view transform
//      (Standard / Filmic / AgX) + the display (sRGB) encode, matching Blender's
//      color management: eeveeView() returns final display color.
//
// It is deliberately NOT a full PBR engine — it ports the specific, common Eevee
// setup of "one sun + a colored/gradient world + Filmic". Compose the chunks into
// your own fragment shader; see examples/.
//
// MIT licensed. No third-party assets.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// GLSL: paste EEVEE_GLSL near the top of a THREE.ShaderMaterial FRAGMENT shader
// (after precision). It defines:
//   vec3  eeveeSky(vec3 dir)                     -- world/env radiance in a direction
//   vec3  eeveeSkyIrradiance(vec3 N)             -- diffuse hemisphere irradiance for normal N
//   vec3  eeveeSunDiffuse(vec3 N)                -- sun Lambert term (color*strength*max(N·L,0))
//   vec3  eeveeShadeDiffuse(vec3 N, vec3 albedo) -- full "Shader to RGB" diffuse (sun + sky + ambient)
//   vec3  eeveeTonemap(vec3 linearColor)         -- exposure + view transform; display-LINEAR [0,1], not encoded
//   vec3  eeveeView(vec3 linearColor)            -- eeveeTonemap + output encode: final color for gl_FragColor
//
// Color management. three.js never encodes a ShaderMaterial's output by itself:
// gl_FragColor reaches the canvas as-is unless the shader calls three's
// linearToOutputTexel (all that #include <colorspace_fragment> does). eeveeView()
// makes that call, so it runs Blender's whole chain: exposure -> view transform ->
// display encode. The encode follows renderer.outputColorSpace, so it is sRGB on a
// normal canvas. Inside a render target three swaps in a linear "encode", so
// post-processing still gets linear values and the final pass (e.g. OutputPass)
// encodes once.
//
// Opt-out: #define EEVEE_LINEAR_OUTPUT (above EEVEE_GLSL, or via material.defines)
// and eeveeView() returns eeveeTonemap()'s display-linear color unencoded. Use it
// when your shader does #include <colorspace_fragment> itself, and in
// RawShaderMaterial or vertex shaders: three defines linearToOutputTexel only in
// ShaderMaterial fragment shaders, so there you must do the encode yourself.
// ---------------------------------------------------------------------------
export const EEVEE_GLSL = /* glsl */`
  // ---- world / sun uniforms (see EeveeEnv.uniforms) ----
  uniform vec3  uEeveeSunDir;      // world-space direction TO the sun (normalized)
  uniform vec3  uEeveeSunColor;    // linear
  uniform float uEeveeSunStrength;
  uniform vec3  uEeveeSkyHorizon;  // linear, gradient bottom (horizon)
  uniform vec3  uEeveeSkyZenith;   // linear, gradient top (zenith)
  uniform float uEeveeSkyStrength;
  uniform float uEeveeSkyGradient;  // 0 = flat (use horizon everywhere), 1 = full gradient
  uniform float uEeveeAmbient;      // extra flat fill as a fraction of sky horizon
  uniform float uEeveeExposure;
  uniform int   uEeveeView;         // 0 Standard, 1 Filmic, 2 AgX

  // World radiance seen looking along dir (dir.y: -1 down .. +1 up).
  vec3 eeveeSky(vec3 dir){
    float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    t = mix(0.0, t, uEeveeSkyGradient);        // gradient amount
    return mix(uEeveeSkyHorizon, uEeveeSkyZenith, t) * uEeveeSkyStrength;
  }

  // Diffuse irradiance from the gradient sky for a surface normal N.
  // A Lambert surface integrates the whole upper hemisphere around N; for a
  // smooth vertical gradient that integral is well-approximated by sampling the
  // sky biased toward the horizon (which dominates the cosine-weighted average).
  vec3 eeveeSkyIrradiance(vec3 N){
    // Effective direction pulled toward horizon so downward normals still catch
    // the bright horizon band (this is what lights cloud/undersides).
    float up = N.y;
    vec3 fill = eeveeSky(vec3(0.0, up * 0.5, 0.0));   // softened vertical sample
    vec3 amb  = uEeveeSkyHorizon * uEeveeSkyStrength * uEeveeAmbient;
    return fill + amb;
  }

  vec3 eeveeSunDiffuse(vec3 N){
    float ndl = max(dot(N, uEeveeSunDir), 0.0);
    return uEeveeSunColor * uEeveeSunStrength * ndl;
  }

  // Full diffuse "Shader to RGB" response: albedo * (sun + sky irradiance).
  vec3 eeveeShadeDiffuse(vec3 N, vec3 albedo){
    return albedo * (eeveeSunDiffuse(N) + eeveeSkyIrradiance(N));
  }

  // ---- view transforms (operate on LINEAR scene-referred color) ----
  // Each returns display-LINEAR color; eeveeView() applies the display encode once.
  vec3 eeveeFilmic(vec3 x){
    // Uncharted-2 filmic curve, a close stand-in for Blender's Filmic look.
    const float A=0.15,B=0.50,C=0.10,D=0.20,E=0.02,F=0.30;
    vec3 c = ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;
    vec3 w = ((vec3(11.2)*(A*vec3(11.2)+C*B)+D*E)/(vec3(11.2)*(A*vec3(11.2)+B)+D*F))-E/F;
    return c / w;
  }
  // sRGB decode (display code value -> display-linear); inverse of three's sRGBTransferOETF.
  vec3 eeveeSRGBToLinear(vec3 c){
    return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
  }
  // Minimal AgX approximation (Blender 4.x default). Punchy contrast + gentle
  // highlight desaturation. Not the full OCIO transform, but visually close.
  // Like real AgX's sigmoid, this curve is shaped in display-encoded space, so
  // its result is decoded to display-linear here; the encode in eeveeView()
  // restores it exactly.
  vec3 eeveeAgx(vec3 x){
    x = max(x, 0.0);
    vec3 v = pow(x / (x + 0.155), vec3(1.0)); // reinhard-ish shoulder
    v = pow(v, vec3(1.0/1.3));                 // contrast
    return eeveeSRGBToLinear(clamp(v, 0.0, 1.0));
  }

  // Exposure + view transform only: display-LINEAR color in [0,1], NOT encoded.
  // Use it to keep working on the color after the view transform (grading, fog,
  // compositing), then encode once at the end with linearToOutputTexel.
  vec3 eeveeTonemap(vec3 col){
    col *= uEeveeExposure;
    if (uEeveeView == 1) col = eeveeFilmic(col);
    else if (uEeveeView == 2) col = eeveeAgx(col);
    return clamp(col, 0.0, 1.0);               // Standard is just the clamp
  }

  // Final display color: exposure -> view transform -> output encode (see the
  // color-management note at the top of eevee.js). Output it as-is.
  vec3 eeveeView(vec3 col){
    col = eeveeTonemap(col);
  #ifndef EEVEE_LINEAR_OUTPUT
    col = linearToOutputTexel(vec4(col, 1.0)).rgb;
  #endif
    return col;
  }
`;

const VIEW = { Standard: 0, Filmic: 1, AgX: 2 };

// ---------------------------------------------------------------------------
// EeveeEnv — owns the world/sun state, builds the uniform block, and keeps the
// sun direction in sync from azimuth/elevation. Merge .uniforms into your
// ShaderMaterial and call .update() (or set fields then .sync()).
// ---------------------------------------------------------------------------
export class EeveeEnv {
  constructor(opts = {}) {
    // Colors accepted as hex/CSS strings or THREE.Color; stored linear via Three's
    // color management (ensure THREE.ColorManagement.enabled = true, the r150+ default).
    const c = (v, d) => new THREE.Color(v ?? d);
    this.sunColor    = c(opts.sunColor, '#fff4de');
    this.sunStrength = opts.sunStrength ?? 1.0;
    this.skyHorizon  = c(opts.skyHorizon, '#87b4e6');
    this.skyZenith   = c(opts.skyZenith, '#1c3a99');
    this.skyStrength = opts.skyStrength ?? 1.0;
    this.skyGradient = opts.skyGradient ?? 1.0;
    this.ambient     = opts.ambient ?? 0.4;
    this.exposure    = opts.exposure ?? 1.0;
    this.view        = opts.view ?? 'Filmic';   // 'Standard' | 'Filmic' | 'AgX'
    this.azimuth     = opts.azimuth ?? 55;      // degrees
    this.elevation   = opts.elevation ?? 55;    // degrees

    this.uniforms = {
      uEeveeSunDir:      { value: new THREE.Vector3() },
      uEeveeSunColor:    { value: this.sunColor },
      uEeveeSunStrength: { value: this.sunStrength },
      uEeveeSkyHorizon:  { value: this.skyHorizon },
      uEeveeSkyZenith:   { value: this.skyZenith },
      uEeveeSkyStrength: { value: this.skyStrength },
      uEeveeSkyGradient: { value: this.skyGradient },
      uEeveeAmbient:     { value: this.ambient },
      uEeveeExposure:    { value: this.exposure },
      uEeveeView:        { value: VIEW[this.view] ?? 1 },
    };
    this.sync();
  }

  // Direction TO the sun from azimuth/elevation (matches a Blender Sun's aim).
  sunDirection() {
    const az = THREE.MathUtils.degToRad(this.azimuth);
    const el = THREE.MathUtils.degToRad(this.elevation);
    return new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ).normalize();
  }

  // Push current field values into the uniform block.
  sync() {
    const u = this.uniforms;
    u.uEeveeSunDir.value.copy(this.sunDirection());
    u.uEeveeSunColor.value.set(this.sunColor);
    u.uEeveeSunStrength.value = this.sunStrength;
    u.uEeveeSkyHorizon.value.set(this.skyHorizon);
    u.uEeveeSkyZenith.value.set(this.skyZenith);
    u.uEeveeSkyStrength.value = this.skyStrength;
    u.uEeveeSkyGradient.value = this.skyGradient;
    u.uEeveeAmbient.value = this.ambient;
    u.uEeveeExposure.value = this.exposure;
    u.uEeveeView.value = VIEW[this.view] ?? 1;
    return this;
  }

  // A CSS/linear clear color to match the world background when you DON'T want
  // the visible background to be the lit sky (Blender's "Is Camera Ray" trick).
  // Returns a THREE.Color you can pass to renderer.setClearColor.
  backgroundColor(hex) { return new THREE.Color(hex ?? '#3b3b3b'); }

  // Optional: wire GUI (lil-gui folder) to all fields.
  addGUI(folder) {
    const hex = (o, k) => ({ get value(){ return '#' + o[k].getHexString(); },
                             set value(v){ o[k].set(v); } });
    folder.add(this, 'view', Object.keys(VIEW)).name('View Transform').onChange(() => this.sync());
    folder.add(this, 'exposure', 0.1, 4, 0.05).name('Exposure').onChange(() => this.sync());
    folder.add(this, 'azimuth', 0, 360, 1).name('Sun Azimuth').onChange(() => this.sync());
    folder.add(this, 'elevation', -10, 90, 1).name('Sun Elevation').onChange(() => this.sync());
    folder.add(this, 'sunStrength', 0, 4, 0.05).name('Sun Strength').onChange(() => this.sync());
    folder.addColor(hex(this, 'sunColor'), 'value').name('Sun Color').onChange(() => this.sync());
    folder.add(this, 'skyStrength', 0, 3, 0.05).name('Sky Strength').onChange(() => this.sync());
    folder.add(this, 'skyGradient', 0, 1, 0.01).name('Sky Gradient').onChange(() => this.sync());
    folder.add(this, 'ambient', 0, 1, 0.01).name('Ambient Fill').onChange(() => this.sync());
    folder.addColor(hex(this, 'skyHorizon'), 'value').name('Sky Horizon').onChange(() => this.sync());
    folder.addColor(hex(this, 'skyZenith'), 'value').name('Sky Zenith').onChange(() => this.sync());
    return folder;
  }
}

// Merge helper: combine several uniform objects into one for ShaderMaterial.
export function mergeUniforms(...objs) {
  return Object.assign({}, ...objs);
}
