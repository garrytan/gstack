import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

class BunFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  async readAsArrayBuffer(blob: Blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }

  async readAsDataURL(blob: Blob) {
    const buffer = Buffer.from(await blob.arrayBuffer());
    this.result = `data:${blob.type};base64,${buffer.toString("base64")}`;
    this.onloadend?.();
  }
}

(globalThis as unknown as { FileReader?: typeof BunFileReader }).FileReader ??=
  BunFileReader;

const outPath = resolve(
  process.argv[2] ?? "artifacts/car-engine/car-engine.glb",
);

const castIron = new MeshStandardMaterial({
  color: 0x33383b,
  metalness: 0.55,
  roughness: 0.42,
});

const darkIron = new MeshStandardMaterial({
  color: 0x141617,
  metalness: 0.48,
  roughness: 0.48,
});

const machinedAluminum = new MeshStandardMaterial({
  color: 0xb7bdc1,
  metalness: 0.82,
  roughness: 0.24,
});

const brushedSteel = new MeshStandardMaterial({
  color: 0x8d9499,
  metalness: 0.74,
  roughness: 0.31,
});

const blackRubber = new MeshStandardMaterial({
  color: 0x050505,
  metalness: 0.02,
  roughness: 0.62,
});

const valveRed = new MeshStandardMaterial({
  color: 0xb7352b,
  metalness: 0.5,
  roughness: 0.28,
});

const brass = new MeshStandardMaterial({
  color: 0xd6ad55,
  metalness: 0.68,
  roughness: 0.26,
});

const ceramic = new MeshStandardMaterial({
  color: 0xf1eee4,
  metalness: 0.02,
  roughness: 0.18,
});

const copperWire = new MeshStandardMaterial({
  color: 0xd26b33,
  metalness: 0.22,
  roughness: 0.36,
});

const translucentBlue = new MeshStandardMaterial({
  color: 0x8fd1ff,
  metalness: 0.05,
  roughness: 0.12,
  transparent: true,
  opacity: 0.42,
});

function makeMesh(
  name: string,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
) {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function box(
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: MeshStandardMaterial,
  rotation: [number, number, number] = [0, 0, 0],
) {
  const result = makeMesh(name, new BoxGeometry(...size), material);
  result.position.set(...position);
  result.rotation.set(...rotation);
  return result;
}

function cylinder(
  name: string,
  radiusTop: number,
  radiusBottom: number,
  depth: number,
  position: [number, number, number],
  material: MeshStandardMaterial,
  rotation: [number, number, number] = [0, 0, 0],
  radialSegments = 48,
) {
  const result = makeMesh(
    name,
    new CylinderGeometry(radiusTop, radiusBottom, depth, radialSegments),
    material,
  );
  result.position.set(...position);
  result.rotation.set(...rotation);
  return result;
}

function sphere(
  name: string,
  radius: number,
  position: [number, number, number],
  material: MeshStandardMaterial,
  scale: [number, number, number] = [1, 1, 1],
) {
  const result = makeMesh(name, new SphereGeometry(radius, 36, 20), material);
  result.position.set(...position);
  result.scale.set(...scale);
  return result;
}

function tube(
  name: string,
  points: Vector3[],
  radius: number,
  material: MeshStandardMaterial,
) {
  const curve = new CatmullRomCurve3(points);
  return makeMesh(
    name,
    new TubeGeometry(curve, 48, radius, 12, false),
    material,
  );
}

function addBoltPattern(
  group: Group,
  prefix: string,
  z: number,
  y: number,
  side: -1 | 1,
) {
  for (let i = 0; i < 5; i += 1) {
    const x = -32 + i * 16;
    const bolt = cylinder(
      `${prefix}-bolt-${i + 1}`,
      1.25,
      1.25,
      1.1,
      [x, y, z],
      brushedSteel,
      [Math.PI / 2, 0, 0],
      24,
    );
    bolt.scale.z = side === -1 ? 0.95 : 1;
    group.add(bolt);
  }
}

function addCylinderBank(
  engine: Group,
  side: -1 | 1,
  label: "left" | "right",
) {
  const bank = new Group();
  bank.name = `${label}-cylinder-bank`;
  bank.rotation.z = side * 0.42;
  bank.position.set(0, side * 13, 8);

  const head = box(
    `${label}-angled-cylinder-head`,
    [76, 11.5, 16],
    [0, side * 12, 7],
    castIron,
    [0, 0, 0],
  );
  bank.add(head);

  const valveCover = box(
    `${label}-red-valve-cover`,
    [70, 10, 7.5],
    [0, side * 19.5, 18.5],
    valveRed,
  );
  bank.add(valveCover);
  addBoltPattern(bank, `${label}-valve-cover`, 22.7, side * 25.2, side);

  const plugXs = [-27, -9, 9, 27];
  plugXs.forEach((x, index) => {
    const plug = cylinder(
      `${label}-spark-plug-${index + 1}`,
      1.55,
      1.55,
      6.4,
      [x, side * 27.2, 15],
      ceramic,
      [Math.PI / 2, 0, 0],
      24,
    );
    bank.add(plug);

    const boot = cylinder(
      `${label}-spark-plug-boot-${index + 1}`,
      1.85,
      1.85,
      2.8,
      [x, side * 30.6, 15],
      blackRubber,
      [Math.PI / 2, 0, 0],
      24,
    );
    bank.add(boot);
  });

  engine.add(bank);
}

function addExhaustHeaders(engine: Group, side: -1 | 1, label: "left" | "right") {
  const header = new Group();
  header.name = `${label}-four-into-one-exhaust-header`;

  const xPositions = [-30, -10, 10, 30];
  xPositions.forEach((x, index) => {
    const runner = tube(
      `${label}-header-runner-${index + 1}`,
      [
        new Vector3(x, side * 33, 4),
        new Vector3(x + (index - 1.5) * 1.5, side * 43, 1),
        new Vector3(x * 0.58, side * 53, -7),
        new Vector3(side * 0 + x * 0.2, side * 62, -10),
      ],
      1.65,
      brushedSteel,
    );
    header.add(runner);
  });

  const collector = cylinder(
    `${label}-exhaust-collector`,
    4.2,
    4.8,
    25,
    [0, side * 67, -10],
    brushedSteel,
    [Math.PI / 2, 0, 0],
    36,
  );
  header.add(collector);
  engine.add(header);
}

function addPulley(
  group: Group,
  name: string,
  radius: number,
  width: number,
  position: [number, number, number],
) {
  const pulley = cylinder(
    name,
    radius,
    radius,
    width,
    position,
    darkIron,
    [Math.PI / 2, 0, 0],
    72,
  );
  group.add(pulley);

  const rim = makeMesh(
    `${name}-front-groove`,
    new TorusGeometry(radius * 0.93, 0.42, 12, 72),
    blackRubber,
  );
  rim.name = `${name}-rubber-groove`;
  rim.position.set(position[0], position[1] - width / 2 - 0.06, position[2]);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
}

function addFrontAccessories(engine: Group) {
  const front = new Group();
  front.name = "front-accessory-drive";

  addPulley(front, "crankshaft-pulley", 9.5, 4, [0, -45, -12]);
  addPulley(front, "water-pump-pulley", 6.5, 3.4, [0, -48, 9]);
  addPulley(front, "alternator-pulley", 4.8, 3.2, [-26, -49, 11]);
  addPulley(front, "idler-pulley", 4.2, 3.2, [24, -49, 4]);

  const belt = tube(
    "single-serpentine-belt",
    [
      new Vector3(0, -50.9, -21.5),
      new Vector3(-25, -51.3, 5),
      new Vector3(-30.5, -51.4, 14),
      new Vector3(-8, -51.2, 18),
      new Vector3(0, -51.1, 15.5),
      new Vector3(27.5, -51.3, 8),
      new Vector3(8.5, -51.2, -15),
      new Vector3(0, -50.9, -21.5),
    ],
    1.1,
    blackRubber,
  );
  front.add(belt);

  const fanHub = cylinder(
    "cooling-fan-hub",
    4.2,
    4.2,
    3.5,
    [0, -58, 9],
    machinedAluminum,
    [Math.PI / 2, 0, 0],
    48,
  );
  front.add(fanHub);

  for (let i = 0; i < 6; i += 1) {
    const blade = box(
      `cooling-fan-blade-${i + 1}`,
      [4.2, 1.2, 17],
      [0, -60.5, 20],
      translucentBlue,
      [0, (Math.PI / 6) * i, 0.24],
    );
    blade.rotation.y = (Math.PI / 3) * i;
    blade.position.x = Math.sin((Math.PI / 3) * i) * 8.5;
    blade.position.z = 9 + Math.cos((Math.PI / 3) * i) * 8.5;
    front.add(blade);
  }

  const alternatorBody = cylinder(
    "alternator-body",
    8,
    8,
    12,
    [-36, -39, 13],
    machinedAluminum,
    [0, 0, Math.PI / 2],
    48,
  );
  front.add(alternatorBody);

  for (let i = 0; i < 8; i += 1) {
    const fin = box(
      `alternator-cooling-slot-${i + 1}`,
      [0.7, 5.8, 1.6],
      [-36 + Math.cos((Math.PI * 2 * i) / 8) * 8.2, -32.8, 13 + Math.sin((Math.PI * 2 * i) / 8) * 8.2],
      darkIron,
      [0, (Math.PI * 2 * i) / 8, 0],
    );
    front.add(fin);
  }

  engine.add(front);
}

function addIgnitionWires(engine: Group) {
  const distributor = cylinder(
    "rear-distributor-cap",
    4.8,
    5.2,
    6,
    [0, 43, 24],
    blackRubber,
    [0, 0, 0],
    36,
  );
  engine.add(distributor);

  const distributorPost = cylinder(
    "brass-distributor-terminal-ring",
    5.4,
    5.4,
    1.2,
    [0, 43, 27.8],
    brass,
    [0, 0, 0],
    36,
  );
  engine.add(distributorPost);

  const plugXs = [-27, -9, 9, 27];
  ([-1, 1] as const).forEach((side) => {
    plugXs.forEach((x, index) => {
      const label = side === -1 ? "left" : "right";
      const wire = tube(
        `${label}-ignition-wire-${index + 1}`,
        [
          new Vector3(0, 43, 29),
          new Vector3(x * 0.25, 35 + index * 1.5, 34 - index * 0.9),
          new Vector3(x * 0.72, side * 12, 29 - index * 1.2),
          new Vector3(x, side * 39.6, 17),
        ],
        0.62,
        copperWire,
      );
      engine.add(wire);
    });
  });
}

function buildEngine() {
  const engine = new Group();
  engine.name = "stylized-v8-car-engine";

  engine.add(box("main-v8-engine-block", [82, 42, 34], [0, 0, -3], castIron));
  engine.add(box("lower-oil-pan", [74, 32, 13], [0, 0, -27], darkIron));
  engine.add(
    box("front-timing-cover", [58, 8, 46], [0, -26, -2], machinedAluminum),
  );
  engine.add(
    box("rear-bellhousing-flange", [68, 7, 39], [0, 28, -3], brushedSteel),
  );

  addCylinderBank(engine, -1, "left");
  addCylinderBank(engine, 1, "right");

  const valleyTray = box(
    "central-valley-tray",
    [54, 23, 6],
    [0, 0, 21],
    machinedAluminum,
  );
  engine.add(valleyTray);

  const intake = new Group();
  intake.name = "intake-manifold-and-carburetor";
  intake.add(box("ribbed-intake-manifold", [48, 19, 8], [0, 0, 28], machinedAluminum));
  for (let i = 0; i < 5; i += 1) {
    intake.add(
      box(
        `intake-manifold-rib-${i + 1}`,
        [2.1, 22, 5],
        [-21 + i * 10.5, 0, 35],
        brushedSteel,
      ),
    );
  }
  intake.add(
    cylinder(
      "four-barrel-carburetor-body",
      9,
      10,
      10,
      [0, 0, 42],
      brushedSteel,
      [0, 0, 0],
      48,
    ),
  );
  intake.add(
    cylinder(
      "round-air-cleaner-housing",
      19,
      19,
      6,
      [0, 0, 50],
      valveRed,
      [0, 0, 0],
      80,
    ),
  );
  intake.add(
    makeMesh(
      "air-cleaner-chrome-lid-ring",
      new TorusGeometry(18.2, 0.9, 16, 80),
      machinedAluminum,
    ),
  );
  intake.children[intake.children.length - 1].position.set(0, 0, 53.2);
  engine.add(intake);

  addExhaustHeaders(engine, -1, "left");
  addExhaustHeaders(engine, 1, "right");
  addFrontAccessories(engine);
  addIgnitionWires(engine);

  engine.add(
    sphere("oil-filter-canister", 4.8, [41, -16, -17], brushedSteel, [0.72, 0.72, 1.65]),
  );
  engine.add(
    cylinder(
      "starter-motor",
      5.6,
      5.6,
      25,
      [-35, 19, -19],
      darkIron,
      [0, 0, Math.PI / 2],
      36,
    ),
  );

  const dipstick = tube(
    "yellow-dipstick-loop-and-tube",
    [
      new Vector3(35, -2, -18),
      new Vector3(38, 4, 0),
      new Vector3(42, 8, 18),
      new Vector3(39, 10, 27),
    ],
    0.55,
    brass,
  );
  engine.add(dipstick);
  engine.add(
    makeMesh(
      "dipstick-finger-loop",
      new TorusGeometry(3.4, 0.48, 12, 32),
      brass,
    ),
  );
  engine.children[engine.children.length - 1].position.set(39, 10, 28);
  engine.children[engine.children.length - 1].rotation.x = Math.PI / 2;

  engine.rotation.x = -0.1;
  engine.rotation.y = -0.35;
  engine.scale.setScalar(0.92);
  return engine;
}

const model = buildEngine();

await mkdir(dirname(outPath), { recursive: true });

const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(model, {
  binary: true,
  trs: false,
  onlyVisible: true,
});

if (!(glb instanceof ArrayBuffer)) {
  throw new Error("Expected GLTFExporter to return a binary GLB ArrayBuffer");
}

await Bun.write(outPath, glb);
console.log(`wrote ${outPath}`);
