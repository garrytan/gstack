import * as THREE from '/vendor/three/build/three.module.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

const canvas = document.querySelector('#scene');
const emptyState = document.querySelector('#empty-state');
const statusPill = document.querySelector('#status-pill');
const scriptPath = document.querySelector('#script-path');
const renderId = document.querySelector('#render-id');
const selectedSource = document.querySelector('#selected-source');
const updatedAt = document.querySelector('#updated-at');
const messageLog = document.querySelector('#message-log');
const recenter = document.querySelector('#recenter');
const toggleGrid = document.querySelector('#toggle-grid');
const toggleAxes = document.querySelector('#toggle-axes');
const rerender = document.querySelector('#rerender');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xffffff, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
camera.position.set(80, 70, 100);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const grid = new THREE.GridHelper(200, 40, 0xa9b7c6, 0xe1e8ef);
scene.add(grid);

const axes = new THREE.AxesHelper(60);
scene.add(axes);

scene.add(new THREE.HemisphereLight(0xffffff, 0xe8eef4, 2.8));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(90, 120, 70);
scene.add(keyLight);

const loader = new GLTFLoader();
let model = null;

function syncToggle(button, visible) {
  button.classList.toggle('is-active', visible);
  button.setAttribute('aria-pressed', visible ? 'true' : 'false');
}

function resize() {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

function animate() {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function setStatus(state) {
  statusPill.textContent = state.status || 'idle';
  statusPill.className = `status-pill ${state.status || ''}`;
  scriptPath.textContent = state.model || 'No model file';
  renderId.textContent = String(state.id ?? 0);
  selectedSource.textContent = state.sizeBytes == null ? state.kind || 'none' : `${state.sizeBytes} bytes`;
  updatedAt.textContent = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : 'never';

  const lines = [];
  if (state.message) lines.push(state.message);
  if (state.reason) lines.push(`reason: ${state.reason}`);
  messageLog.textContent = lines.filter(Boolean).join('\n\n');
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDim * 1.8;
  const direction = new THREE.Vector3(0.8, 0.65, 1).normalize();

  controls.target.copy(center);
  camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
  camera.near = Math.max(maxDim / 1000, 0.01);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
  });
}

function loadModel(url) {
  loader.load(
    url,
    (gltf) => {
      if (model) {
        scene.remove(model);
        disposeObject(model);
      }
      model = gltf.scene;
      scene.add(model);
      emptyState.classList.add('is-hidden');
      frameObject(model);
    },
    undefined,
    (error) => {
      messageLog.textContent = `Failed to load GLB: ${error.message || error}`;
    },
  );
}

async function refreshStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  const state = await response.json();
  setStatus(state);
  if (state.status === 'ready') loadModel(state.modelUrl);
}

const events = new EventSource('/events');
function stateFromEvent(event) {
  if (!event.data) return null;
  try {
    return JSON.parse(event.data);
  } catch (error) {
    console.warn('Ignoring malformed cad-coder event', error);
    return null;
  }
}

for (const eventName of ['connected', 'ready', 'error']) {
  events.addEventListener(eventName, (event) => {
    const state = stateFromEvent(event);
    if (!state) return;
    setStatus(state);
    if (state.status === 'ready') loadModel(state.modelUrl);
  });
}

recenter.addEventListener('click', () => {
  if (model) frameObject(model);
});

toggleGrid.addEventListener('click', () => {
  grid.visible = !grid.visible;
  syncToggle(toggleGrid, grid.visible);
});

toggleAxes.addEventListener('click', () => {
  axes.visible = !axes.visible;
  syncToggle(toggleAxes, axes.visible);
});

rerender.addEventListener('click', async () => {
  await fetch('/api/reload', { method: 'POST' });
});

window.addEventListener('resize', resize);
syncToggle(toggleGrid, grid.visible);
syncToggle(toggleAxes, axes.visible);
refreshStatus();
animate();
