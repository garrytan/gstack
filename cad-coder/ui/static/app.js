import * as THREE from '/vendor/three/build/three.module.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

const canvas = document.querySelector('#scene');
const pinLayer = document.querySelector('#pin-layer');
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
const notesCount = document.querySelector('#notes-count');
const notesList = document.querySelector('#notes-list');
const noteForm = document.querySelector('#note-form');
const noteFormLabel = document.querySelector('#note-form-label');
const noteText = document.querySelector('#note-text');
const saveNote = document.querySelector('#save-note');
const cancelNote = document.querySelector('#cancel-note');
const sendNotes = document.querySelector('#send-notes');
const changeRequestStatus = document.querySelector('#change-request-status');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xffffff, 1);
// sRGB output: GLB stores colors in linear space; without this we display
// linear values on an sRGB monitor, which crushes mid-tones to black.
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

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

// Universal lighting rig: ambient fills every surface equally, hemisphere
// adds subtle sky/ground variation, and 6 directional lights from each
// principal axis give enough shape definition to read geometry without
// any face going dark. Intensities tuned for sRGB+ACES output above.
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
scene.add(new THREE.HemisphereLight(0xffffff, 0xe8eef4, 0.5));
const lightRig = [
  [ 100,    0,    0, 0.6],   // +X
  [-100,    0,    0, 0.6],   // -X
  [   0,  100,    0, 0.8],   // +Y top
  [   0, -100,    0, 0.6],   // -Y bottom
  [   0,    0,  100, 0.6],   // +Z front
  [   0,    0, -100, 0.6],   // -Z back
];
for (const [x, y, z, intensity] of lightRig) {
  const light = new THREE.DirectionalLight(0xffffff, intensity);
  light.position.set(x, y, z);
  scene.add(light);
}

const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let model = null;
let notes = [];
let pendingAnchor = null;
let editingNoteId = null;
let pinAnchors = new Map();

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

function rounded(value) {
  return Number(value.toFixed(4));
}

function vectorTuple(vector) {
  return [rounded(vector.x), rounded(vector.y), rounded(vector.z)];
}

function cameraSnapshot() {
  return {
    position: vectorTuple(camera.position),
    target: vectorTuple(controls.target),
  };
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
      updatePinPositions();
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

async function refreshNotes() {
  const response = await fetch('/api/notes', { cache: 'no-store' });
  if (!response.ok) return;
  const state = await response.json();
  setNotes(state);
}

function setNotes(state) {
  notes = Array.isArray(state.notes) ? state.notes : [];
  if (state.changeRequestMarkdownPath) {
    changeRequestStatus.textContent = `Pending for gstack agent: ${state.changeRequestMarkdownPath}`;
  }
  renderNotes();
  renderPins();
}

function noteNumber(note) {
  return notes.findIndex((item) => item.id === note.id) + 1;
}

function anchorSummary(anchor) {
  if (!anchor) return 'No anchor';
  if (anchor.kind === 'model-point' && anchor.world) {
    const location = `3D point [${anchor.world.map((value) => Number(value).toFixed(2)).join(', ')}]`;
    const face = Number.isInteger(anchor.faceIndex) ? `, face ${anchor.faceIndex}` : '';
    const mesh = anchor.meshName || anchor.objectName;
    return mesh ? `${location}${face} on ${mesh}` : `${location}${face}`;
  }
  return `Screen point (${Math.round(anchor.screen.x)}, ${Math.round(anchor.screen.y)})`;
}

function renderNotes() {
  notesCount.textContent = String(notes.length);
  notesList.innerHTML = '';

  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'notes-empty';
    empty.textContent = 'No notes yet.';
    notesList.append(empty);
  }

  for (const note of notes) {
    const card = document.createElement('article');
    card.className = `note-card ${note.status}`;
    card.id = `note-${note.id}`;

    const header = document.createElement('div');
    header.className = 'note-card-header';

    const title = document.createElement('strong');
    title.textContent = `Note ${noteNumber(note)}`;
    const status = document.createElement('span');
    status.textContent = note.status;
    header.append(title, status);

    const body = document.createElement('p');
    body.textContent = note.text;

    const meta = document.createElement('p');
    meta.className = 'note-meta';
    meta.textContent = anchorSummary(note.anchor);

    card.append(header, body, meta);

    if (note.status === 'draft') {
      const actions = document.createElement('div');
      actions.className = 'note-card-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => startEditingNote(note));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deleteNote(note.id));

      actions.append(edit, remove);
      card.append(actions);
    }

    notesList.append(card);
  }

  const draftCount = notes.filter((note) => note.status === 'draft').length;
  sendNotes.disabled = draftCount === 0;
  sendNotes.textContent = draftCount === 1 ? 'Send 1 note to gstack' : `Send ${draftCount} notes to gstack`;
}

function renderPins() {
  pinAnchors = new Map();
  pinLayer.innerHTML = '';

  for (const note of notes) {
    const pin = document.createElement('button');
    pin.className = `note-pin ${note.status}`;
    pin.type = 'button';
    pin.textContent = String(noteNumber(note));
    pin.title = note.text;
    pin.dataset.pinId = note.id;
    pin.addEventListener('click', () => {
      document.querySelector(`#note-${CSS.escape(note.id)}`)?.scrollIntoView({ block: 'nearest' });
    });
    pinAnchors.set(note.id, note.anchor);
    pinLayer.append(pin);
  }

  if (pendingAnchor) {
    const pin = document.createElement('span');
    pin.className = 'note-pin pending';
    pin.textContent = '+';
    pin.dataset.pinId = 'pending';
    pinAnchors.set('pending', pendingAnchor);
    pinLayer.append(pin);
  }

  updatePinPositions();
}

function updatePinPositions() {
  if (!pinLayer) return;
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;

  for (const pin of pinLayer.querySelectorAll('.note-pin')) {
    const anchor = pinAnchors.get(pin.dataset.pinId);
    if (!anchor) continue;

    let x = anchor.screen.x;
    let y = anchor.screen.y;
    let visible = true;

    if (anchor.kind === 'model-point' && anchor.world) {
      const projected = new THREE.Vector3(...anchor.world).project(camera);
      visible = projected.z >= -1 && projected.z <= 1;
      x = (projected.x * 0.5 + 0.5) * width;
      y = (-projected.y * 0.5 + 0.5) * height;
    }

    pin.style.left = `${x}px`;
    pin.style.top = `${y}px`;
    pin.classList.toggle('is-hidden', !visible);
  }
}

function anchorFromContextMenu(event) {
  const rect = canvas.getBoundingClientRect();
  const screen = {
    x: Math.round(event.clientX - rect.left),
    y: Math.round(event.clientY - rect.top),
  };

  pointer.x = (screen.x / Math.max(rect.width, 1)) * 2 - 1;
  pointer.y = -(screen.y / Math.max(rect.height, 1)) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hit = model ? raycaster.intersectObject(model, true)[0] : null;
  if (!hit) return { kind: 'screen', screen };

  const nodePath = [];
  for (let node = hit.object; node && node !== scene; node = node.parent) {
    nodePath.push(node.name || node.type || 'node');
  }
  nodePath.reverse();

  let materialName;
  if (Array.isArray(hit.object.material)) {
    materialName = hit.object.material.map((material) => material.name).filter(Boolean).join(', ');
  } else if (hit.object.material?.name) {
    materialName = hit.object.material.name;
  }

  let normal;
  if (hit.face) {
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    normal = vectorTuple(worldNormal);
  }

  return {
    kind: 'model-point',
    world: vectorTuple(hit.point),
    screen,
    objectName: hit.object.name || hit.object.parent?.name || undefined,
    nodePath: nodePath.join(' / ') || undefined,
    meshName: hit.object.name || undefined,
    materialName: materialName || undefined,
    faceIndex: Number.isInteger(hit.faceIndex) ? hit.faceIndex : undefined,
    normal,
  };
}

function showNoteForm(anchor, text = '') {
  pendingAnchor = anchor;
  editingNoteId = null;
  noteFormLabel.textContent = 'New note';
  saveNote.textContent = 'Save note';
  noteText.value = text;
  noteForm.classList.remove('is-hidden');
  noteText.focus();
  renderPins();
}

function startEditingNote(note) {
  pendingAnchor = note.anchor;
  editingNoteId = note.id;
  noteFormLabel.textContent = `Edit note ${noteNumber(note)}`;
  saveNote.textContent = 'Update note';
  noteText.value = note.text;
  noteForm.classList.remove('is-hidden');
  noteText.focus();
  renderPins();
}

function hideNoteForm() {
  pendingAnchor = null;
  editingNoteId = null;
  noteText.value = '';
  noteForm.classList.add('is-hidden');
  renderPins();
}

async function saveCurrentNote() {
  const text = noteText.value.trim();
  if (!text) return;

  const response = editingNoteId
    ? await fetch(`/api/notes/${encodeURIComponent(editingNoteId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    : await fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, anchor: pendingAnchor, camera: cameraSnapshot() }),
    });

  const state = await response.json();
  if (!response.ok) {
    messageLog.textContent = state.error || 'Failed to save note';
    return;
  }
  setNotes(state);
  hideNoteForm();
}

async function deleteNote(id) {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const state = await response.json();
  if (!response.ok) {
    messageLog.textContent = state.error || 'Failed to delete note';
    return;
  }
  setNotes(state);
}

async function submitChangeRequest() {
  const response = await fetch('/api/change-request', { method: 'POST' });
  const state = await response.json();
  if (!response.ok) {
    changeRequestStatus.textContent = state.error || 'No draft notes to send.';
    return;
  }
  setNotes(state);
  changeRequestStatus.textContent = `Pending for gstack agent: ${state.changeRequest.files.markdown}`;
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

events.addEventListener('notes', (event) => {
  const state = stateFromEvent(event);
  if (state) setNotes(state);
});

events.addEventListener('change-request', (event) => {
  const state = stateFromEvent(event);
  if (!state?.files?.markdown) return;
  changeRequestStatus.textContent = `Pending for gstack agent: ${state.files.markdown}`;
});

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

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showNoteForm(anchorFromContextMenu(event));
});

noteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveCurrentNote();
});

cancelNote.addEventListener('click', hideNoteForm);
sendNotes.addEventListener('click', submitChangeRequest);

window.addEventListener('resize', resize);
syncToggle(toggleGrid, grid.visible);
syncToggle(toggleAxes, axes.visible);
refreshStatus();
refreshNotes();
animate();
