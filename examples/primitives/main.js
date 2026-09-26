// Primitives example: light a sphere + torus-knot + ground with the eevee-threejs
// module, and switch view transforms live. This is the minimal showcase of the
// lighting port — one directional sun + a gradient-sky world + a view transform.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { EEVEE_GLSL, EeveeEnv, mergeUniforms } from 'eevee-threejs';

THREE.ColorManagement.enabled = true;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace; // eeveeView() encodes to this
renderer.toneMapping = THREE.NoToneMapping; // eeveeView() does exposure + view transform in-shader
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(4, 2.6, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.4, 0);

// --- the Eevee environment ---
const env = new EeveeEnv({
  sunColor: '#fff2d0', sunStrength: 2.2,
  skyHorizon: '#9cc0ec', skyZenith: '#1f3f9c',
  skyStrength: 0.8, ambient: 0.35, exposure: 1.2, view: 'AgX',
  azimuth: 50, elevation: 55,
});
renderer.setClearColor(env.backgroundColor('#2f3133'), 1);

// --- a diffuse material built on the eevee chunks ---
function eeveeDiffuseMaterial(albedoHex) {
  return new THREE.ShaderMaterial({
    uniforms: mergeUniforms(env.uniforms, { uAlbedo: { value: new THREE.Color(albedoHex) } }),
    vertexShader: /* glsl */`
      varying vec3 vN;
      void main(){
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      ${EEVEE_GLSL}
      uniform vec3 uAlbedo;
      varying vec3 vN;
      void main(){
        vec3 lit = eeveeShadeDiffuse(normalize(vN), uAlbedo);
        gl_FragColor = vec4(eeveeView(lit), 1.0);   // final, display-encoded color
      }
    `,
  });
}

const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), eeveeDiffuseMaterial('#c85a3c'));
sphere.position.set(-1.6, 0.6, 0);
scene.add(sphere);

const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.7, 0.24, 200, 32), eeveeDiffuseMaterial('#d8d2c4'));
knot.position.set(1.5, 0.7, 0);
scene.add(knot);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), eeveeDiffuseMaterial('#6f7480'));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// --- GUI ---
const gui = new GUI({ title: 'eevee-threejs' });
env.addGUI(gui.addFolder('Eevee Environment'));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// expose for automated validation
window.__demo = { env, camera, controls };

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  knot.rotation.y += 0.004;
  renderer.render(scene, camera);
}
animate();
