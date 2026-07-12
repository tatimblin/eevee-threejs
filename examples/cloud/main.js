// Painterly billboard cloud, lit by the eevee-threejs module.
//
// This is an ORIGINAL demo: the brush-stroke alpha atlas is generated procedurally
// on a <canvas> at runtime (no third-party/paid textures), and the geometry is a
// simple noise-displaced blob scattered with camera-facing cards. The interesting
// part — how it gets lit — comes entirely from eevee-threejs (sun + gradient sky
// world + Shader-to-RGB diffuse + view transform).
//
// Technique notes (things Eevee/Blender do implicitly that a WebGL port must add):
//   * The light/shadow gradient is driven by a SMOOTH bounding-sphere normal so it
//     reads as one coherent mass, not per-card blotches.
//   * A FRONT-SHELL fade hides back/interior cards that would otherwise bleed their
//     shadow side through the transparent front (Blender hides them behind a mesh).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { EEVEE_GLSL, EeveeEnv, mergeUniforms } from 'eevee-threejs';

THREE.ColorManagement.enabled = true;

// ---------------------------------------------------------------------------
// Procedural brush-stroke atlas (2x2 grid of soft painterly puffs) on a canvas.
// ---------------------------------------------------------------------------
function makeBrushAtlas(size = 1024, seed = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  let s = seed * 9301 + 49297;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const cell = size / 2;
  for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 2; gx++) {
    const ox = gx * cell, oy = gy * cell, c = cell * 0.5;
    // build a blob from many soft radial dabs, then scratchy strokes for texture
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, cell, cell); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 220; i++) {
      const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), 0.6) * c * 0.8;
      const x = ox + c + Math.cos(a) * r, y = oy + c + Math.sin(a) * r * 0.8;
      const rad = c * (0.10 + rnd() * 0.22);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const v = 0.10 + rnd() * 0.22;
      g.addColorStop(0, `rgba(255,255,255,${v})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
    }
    // brush scratches near edges for the painterly rim
    for (let i = 0; i < 500; i++) {
      const a = rnd() * Math.PI * 2, r = c * (0.55 + rnd() * 0.5);
      const x = ox + c + Math.cos(a) * r, y = oy + c + Math.sin(a) * r * 0.8;
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + rnd() * 0.15})`;
      ctx.lineWidth = 1 + rnd() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * (4 + rnd() * 14), y + Math.sin(a) * (4 + rnd() * 14));
      ctx.stroke();
    }
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Deterministic RNG + value noise for the blob form.
// ---------------------------------------------------------------------------
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function h3(x,y,z){let h=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453;return h-Math.floor(h);}
function vnoise(x,y,z){const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z),xf=x-xi,yf=y-yi,zf=z-zi;const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf),w=zf*zf*(3-2*zf);const L=(a,b,t)=>a+(b-a)*t;return L(L(L(h3(xi,yi,zi),h3(xi+1,yi,zi),u),L(h3(xi,yi+1,zi),h3(xi+1,yi+1,zi),u),v),L(L(h3(xi,yi,zi+1),h3(xi+1,yi,zi+1),u),L(h3(xi,yi+1,zi+1),h3(xi+1,yi+1,zi+1),u),v),w);}
function fbm(x,y,z){let f=0,a=0.5,sc=1;for(let i=0;i<3;i++){f+=a*vnoise(x*sc,y*sc,z*sc);sc*=2;a*=0.5;}return f;}

// ---------------------------------------------------------------------------
// Scene + Eevee environment
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 200);
camera.position.set(6, 2.2, 9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.target.set(0, 0.2, 0);

const env = new EeveeEnv({
  sunColor: '#fff4de', sunStrength: 2.6,
  skyHorizon: '#a8cbf0', skyZenith: '#3f68c0',
  skyStrength: 0.9, ambient: 0.6, exposure: 1.4, view: 'Filmic',
  azimuth: 65, elevation: 55,
});
renderer.setClearColor(env.backgroundColor('#3b3b3b'), 1);

const params = {
  seed: 1, density: 900, cardScale: 1.5, scaleRandom: 0.5, rotateRandom: 0.35,
  contrast: 0.18, shadowTint: '#8fb4dd', transition: 0.6, rim: 0.4, gradientZ: 0.5,
};

let atlas = makeBrushAtlas(1024, params.seed);

const material = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: mergeUniforms(env.uniforms, {
    uAtlas: { value: atlas },
    uCamPos: { value: new THREE.Vector3() },
    uShadowTint: { value: new THREE.Color(params.shadowTint) },
    uContrast: { value: params.contrast },
    uTransition: { value: params.transition },
    uRim: { value: params.rim },
    uGradientZ: { value: params.gradientZ },
    uCloudMinY: { value: 0 }, uCloudSizeY: { value: 1 },
  }),
  vertexShader: /* glsl */`
    attribute vec3 iCenter; attribute vec3 nSmooth; attribute vec3 nDetail;
    attribute vec2 iCell; attribute float iScale; attribute float iRot;
    uniform vec3 uCamPos;
    varying vec2 vUv; varying vec3 vNs; varying vec3 vNd; varying vec3 vWorld; varying float vFacing;
    void main(){
      vNs = normalize(nSmooth); vNd = normalize(nDetail);
      vec3 toCam = normalize(uCamPos - iCenter);
      vFacing = dot(vNs, toCam);
      vec3 camR = vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);
      vec3 camU = vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
      float c=cos(iRot),s=sin(iRot); vec2 p=position.xy*iScale;
      vec2 pr=vec2(p.x*c-p.y*s,p.x*s+p.y*c);
      vec3 world=iCenter+camR*pr.x+camU*pr.y;
      vWorld=world; vUv=(uv+iCell)/2.0;
      gl_Position=projectionMatrix*viewMatrix*vec4(world,1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    ${EEVEE_GLSL}
    uniform sampler2D uAtlas; uniform vec3 uCamPos; uniform vec3 uShadowTint;
    uniform float uContrast; uniform float uTransition; uniform float uRim;
    uniform float uGradientZ; uniform float uCloudMinY; uniform float uCloudSizeY;
    varying vec2 vUv; varying vec3 vNs; varying vec3 vNd; varying vec3 vWorld; varying float vFacing;

    float hash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
    float noise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
      return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)),d/(q.x+1e-10),q.x);}
    vec3 hsv2rgb(vec3 c){vec4 K=vec4(1.,2./3.,1./3.,3.);vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);}

    void main(){
      float alpha = texture2D(uAtlas, vUv).r;
      alpha *= smoothstep(-0.5, 0.15, vFacing);   // front-shell fade
      if (alpha < 0.02) discard;

      // STAGE 1 — Eevee lighting via the module. Shadow gradient follows the
      // SMOOTH normal (coherent mass); detail only perturbs the sun a touch.
      vec3 N = normalize(mix(vNs, vNd, 0.30));
      vec3 lit = eeveeShadeDiffuse(mix(vNs, N, 0.5), vec3(0.9));

      // STAGE 2 — NPR grade on top of the lit color.
      float f = dot(vNs, uEeveeSunDir) * 0.5 + 0.5;          // smooth light factor
      float k = mix(1.0, 6.0, uContrast);
      float band = smoothstep(0.0, 1.0, clamp((f-0.5)*k+0.5, 0.0, 1.0));
      vec3 tint = uShadowTint / max(max(uShadowTint.r,uShadowTint.g),uShadowTint.b);
      vec3 col = lit * mix(mix(vec3(1.0), tint, 0.5), vec3(1.0), band);

      // transition color variation in mid-tones
      float var = noise(vWorld*0.6) - 0.5;
      float mid = band*(1.0-band)*4.0;
      vec3 hsv = rgb2hsv(col);
      hsv.x = fract(hsv.x + var*0.03*uTransition*mid);
      hsv.z = clamp(hsv.z + var*0.10*uTransition*mid, 0.0, 1.0);
      col = hsv2rgb(hsv);

      // rim light toward the sun
      vec3 V = normalize(uCamPos - vWorld);
      float fres = pow(1.0 - clamp(dot(V,N),0.0,1.0), 3.0);
      float rim = fres * max(dot(N,uEeveeSunDir),0.0) * uRim;
      col = 1.0 - (1.0-col)*(1.0-rim*uEeveeSunColor);

      // gradient Z
      float zt = clamp((vWorld.y-uCloudMinY)/max(uCloudSizeY,1e-3), 0.0, 1.0);
      col *= mix(1.0-0.2*uGradientZ, 1.0, zt);

      gl_FragColor = vec4(eeveeView(col), alpha);   // view transform via module
    }
  `,
});

let mesh = null;
function buildCloud() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  const rng = mulberry32(params.seed * 2654435761);
  const N = Math.max(50, Math.floor(params.density));
  const R = new THREE.Vector3(2.6, 1.3, 1.7);
  const centers=[], nSmooth=[], nDetail=[], cells=[], scales=[], rots=[];
  const min = new THREE.Vector3(1e9,1e9,1e9), max = new THREE.Vector3(-1e9,-1e9,-1e9);
  const raw = [];
  for (let i=0;i<N;i++){
    const u=rng(),v=rng(),th=2*Math.PI*u,ph=Math.acos(2*v-1);
    const dir=new THREE.Vector3(Math.sin(ph)*Math.cos(th),Math.cos(ph),Math.sin(ph)*Math.sin(th));
    const p=new THREE.Vector3(dir.x*R.x,dir.y*R.y,dir.z*R.z);
    const n0=new THREE.Vector3(dir.x/R.x,dir.y/R.y,dir.z/R.z).normalize();
    const d=(fbm(p.x*0.6+10,p.y*0.6,p.z*0.6)-0.4)*0.06*5*4;
    p.addScaledVector(n0,d); if(p.y<0)p.y*=0.55;
    const off=0.5+(rng()-0.5)*0.7; const c=p.clone().addScaledVector(n0,off);
    const dn=n0.clone().add(new THREE.Vector3(fbm(c.x*2+5,c.y*2,c.z*2)-0.5,fbm(c.x*2,c.y*2+5,c.z*2)-0.5,fbm(c.x*2,c.y*2,c.z*2+5)-0.5).multiplyScalar(0.5)).normalize();
    raw.push(c); nDetail.push(dn.x,dn.y,dn.z);
    cells.push(Math.floor(rng()*2),Math.floor(rng()*2));
    scales.push(params.cardScale*(1-rng()*params.scaleRandom));
    rots.push((rng()-0.5)*Math.PI*params.rotateRandom);
    min.min(c); max.max(c);
  }
  const ctr=min.clone().add(max).multiplyScalar(0.5);
  for(const c of raw){centers.push(c.x,c.y,c.z);const s=c.clone().sub(ctr).normalize();nSmooth.push(s.x,s.y,s.z);}
  const quad=new THREE.PlaneGeometry(1,1);
  const geo=new THREE.InstancedBufferGeometry();
  geo.index=quad.index; geo.attributes.position=quad.attributes.position; geo.attributes.uv=quad.attributes.uv;
  geo.instanceCount=N;
  const f3=a=>new THREE.InstancedBufferAttribute(new Float32Array(a),3);
  geo.setAttribute('iCenter',f3(centers)); geo.setAttribute('nSmooth',f3(nSmooth)); geo.setAttribute('nDetail',f3(nDetail));
  geo.setAttribute('iCell',new THREE.InstancedBufferAttribute(new Float32Array(cells),2));
  geo.setAttribute('iScale',new THREE.InstancedBufferAttribute(new Float32Array(scales),1));
  geo.setAttribute('iRot',new THREE.InstancedBufferAttribute(new Float32Array(rots),1));
  mesh=new THREE.Mesh(geo,material); mesh.frustumCulled=false; scene.add(mesh);
  material.uniforms.uCloudMinY.value=min.y; material.uniforms.uCloudSizeY.value=max.y-min.y;
}

const gui = new GUI({ title: 'eevee-threejs · cloud' });
const gf = gui.addFolder('Cloud');
gf.add(params,'seed',1,50,1).name('Seed').onChange(v=>{atlas=makeBrushAtlas(1024,v);material.uniforms.uAtlas.value=atlas;buildCloud();});
gf.add(params,'density',100,2500,10).name('Density').onChange(buildCloud);
gf.add(params,'cardScale',0.3,3,0.01).name('Card Scale').onChange(buildCloud);
gf.add(params,'scaleRandom',0,1,0.01).name('Scale Random').onChange(buildCloud);
gf.add(params,'rotateRandom',0,1,0.01).name('Rotate Random').onChange(buildCloud);
gf.add(params,'contrast',0,1,0.01).name('Contrast').onChange(v=>material.uniforms.uContrast.value=v);
gf.addColor(params,'shadowTint').name('Shadow Tint').onChange(v=>material.uniforms.uShadowTint.value.set(v));
gf.add(params,'transition',0,1,0.01).name('Transition Var').onChange(v=>material.uniforms.uTransition.value=v);
gf.add(params,'rim',0,1,0.01).name('Rim Light').onChange(v=>material.uniforms.uRim.value=v);
gf.add(params,'gradientZ',0,1,0.01).name('Gradient Z').onChange(v=>material.uniforms.uGradientZ.value=v);
env.addGUI(gui.addFolder('Eevee Environment'));

window.__demo = { env, params, buildCloud, camera, controls, material };
buildCloud();

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
function animate(){requestAnimationFrame(animate);controls.update();material.uniforms.uCamPos.value.copy(camera.position);renderer.render(scene,camera);}
animate();
