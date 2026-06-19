import * as THREE from 'https://unpkg.com/three@0.152.2/build/three.module.js';

// Phase 2: Procedural generation core (hallways & rectangular rooms), chunking/streaming,
// uniqueness mandate (randomized greys + black splotches via canvas textures),
// node graph generation, and unloading of nodes behind player.

// This file builds on the Phase 1 scaffold. It replaces the placeholder initializeLeviathanComplex
// with a working graph-based generator that streams nodes (3-4 ahead) and disposes of distant nodes.

let camera, scene, renderer;
let controls = {
  velocity: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
  canJump: false,
};
let prevTime = performance.now();
let raycaster;
let interactiveObjects = [];
let playerLight;

// Procedural system state
let GlobalSeed = Math.floor(Math.random()*0xffffffff);
let RNG = mulberry32(GlobalSeed);

// Chunking parameters
const TARGET_AHEAD = 4;
const UNLOAD_DISTANCE = 250; // meters

// Node registry
const Nodes = new Map();
let currentNodeId = null;

init();
animate();

function init(){
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // camera
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
  camera.position.set(0,1.6,0);

  // lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(ambient);

  playerLight = new THREE.PointLight(0xfff9e0, 0.5, 20, 2);
  camera.add(playerLight);
  scene.add(camera);

  // raycaster
  raycaster = new THREE.Raycaster();

  // build the threshold hallway from Phase 1
  buildThreshold();

  // pointer lock and input
  setupPointerLock();
  setupInput();

  window.addEventListener('resize', onWindowResize);
}

// ---------- Procedural utilities ----------
function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}
function rndRange(rng, a, b){ return a + (b-a) * rng(); }
function rndInt(rng, a, b){ return Math.floor(rndRange(rng, a, b+1)); }

function seededRNGForNode(nodeIndex){
  // create a reproducible RNG for a node based on global seed + index
  return mulberry32((GlobalSeed ^ nodeIndex) >>> 0);
}

// ---------- Textures (Uniqueness Mandate) ----------
function makeGreyWallTexture(seedRng){
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  // choose grey base shade
  const shade = Math.floor(rndRange(seedRng, 40, 180));
  ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
  ctx.fillRect(0,0,size,size);
  // splotches of black
  const splotches = rndInt(seedRng, 4, 18);
  for(let i=0;i<splotches;i++){
    ctx.fillStyle = `rgba(0,0,0,${rndRange(seedRng,0.06,0.25)})`;
    const w = rndRange(seedRng, size*0.05, size*0.4);
    const h = rndRange(seedRng, size*0.05, size*0.4);
    const x = rndRange(seedRng, 0, size - w);
    const y = rndRange(seedRng, 0, size - h);
    ctx.beginPath();
    ctx.ellipse(x + w/2, y + h/2, w/2, h/2, rndRange(seedRng,0,Math.PI), 0, Math.PI*2);
    ctx.fill();
  }
  // light noise
  ctx.fillStyle = 'rgba(0,0,0,0.02)';
  for(let i=0;i<2000;i++) ctx.fillRect(Math.random()*size, Math.random()*size,1,1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// shared carpet for rooms (simple)
function makeRoomFloorTexture(){
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8d8d8d';
  ctx.fillRect(0,0,size,size);
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for(let i=0;i<500;i++) ctx.fillRect(Math.random()*size, Math.random()*size,1,1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

const sharedRoomFloorTexture = makeRoomFloorTexture();

// ---------- Node generation & geometry ----------
let nextNodeIndex = 1;
function createNode(type, originPos, forwardDir, index){
  const rng = seededRNGForNode(index);
  const node = {
    id: index,
    type,
    position: originPos.clone(),
    forward: forwardDir.clone(),
    group: new THREE.Group(),
    bbox: null, // THREE.Box3
    textures: [], // track textures to dispose later
  };

  if(type === 'hallway'){
    // length between 15m and 600m per PRD
    const length = rndRange(rng, 15, 600);
    const width = rndRange(rng, 2, 4);
    const height = rndRange(rng, 2.6, 3.4);
    node.length = length;
    node.width = width;
    node.height = height;

    buildHallwayGeometry(node, rng);
  } else if(type === 'rectroom'){
    // rectangular room extreme variance
    const sx = rndRange(rng, 1, 50);
    const sy = rndRange(rng, 1, 15);
    const sz = rndRange(rng, 1, 30);
    node.size = new THREE.Vector3(sx, sy, sz);
    buildRectRoomGeometry(node, rng);
  }

  node.group.position.copy(node.position);
  node.group.userData.nodeId = node.id;

  // compute bbox (approx via bounding sphere / box)
  const box = new THREE.Box3().setFromObject(node.group);
  node.bbox = box;

  return node;
}

function buildHallwayGeometry(node, rng){
  const group = node.group;
  const segLength = Math.min(10, node.length); // split long hallway into manageable segments (up to 10m each)
  const count = Math.ceil(node.length / segLength);

  // create wall texture unique to this node
  const wallTex = makeGreyWallTexture(rng);
  node.textures.push(wallTex);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex });
  const floorMat = new THREE.MeshStandardMaterial({ map: sharedRoomFloorTexture });

  for(let i=0;i<count;i++){
    const length = (i === count-1) ? (node.length - segLength*(count-1)) : segLength;
    const z = - (i * segLength + length/2);
    // left wall
    const leftGeo = new THREE.BoxGeometry(node.width, node.height, 0.1);
    const left = new THREE.Mesh(leftGeo, wallMat);
    left.position.set(-node.width/2 - 0.05, node.height/2, z);
    group.add(left);
    // right wall
    const right = new THREE.Mesh(leftGeo, wallMat);
    right.position.set(node.width/2 + 0.05, node.height/2, z);
    group.add(right);
    // floor strip
    const floorGeo = new THREE.PlaneGeometry(node.width, length);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI/2;
    floor.position.set(0,0,z);
    group.add(floor);
    // ceiling
    const ceil = new THREE.Mesh(floorGeo, wallMat);
    ceil.rotation.x = Math.PI/2;
    ceil.position.set(0,node.height,z);
    group.add(ceil);
  }

  // set group orientation based on forward vector
  const dir = node.forward.clone().normalize();
  const angle = Math.atan2(dir.x, dir.z);
  group.rotation.y = angle;
}

function buildRectRoomGeometry(node, rng){
  const size = node.size;
  const group = node.group;

  // wall texture unique to this node with splotches
  const wallTex = makeGreyWallTexture(rng);
  node.textures.push(wallTex);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, side: THREE.BackSide });
  const floorMat = new THREE.MeshStandardMaterial({ map: sharedRoomFloorTexture });

  // create a box room: floor, ceiling, 4 walls
  const floorGeo = new THREE.PlaneGeometry(size.x, size.z);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI/2;
  floor.position.set(0, 0, 0);
  group.add(floor);

  const ceil = new THREE.Mesh(floorGeo, wallMat);
  ceil.rotation.x = Math.PI/2;
  ceil.position.set(0, size.y, 0);
  group.add(ceil);

  // walls
  const wallGeo = new THREE.PlaneGeometry(size.z, size.y);
  const wall1 = new THREE.Mesh(wallGeo, wallMat);
  wall1.position.set(-size.x/2, size.y/2, 0);
  wall1.rotation.y = Math.PI/2;
  group.add(wall1);

  const wall2 = new THREE.Mesh(wallGeo, wallMat);
  wall2.position.set(size.x/2, size.y/2, 0);
  wall2.rotation.y = -Math.PI/2;
  group.add(wall2);

  const wallGeo2 = new THREE.PlaneGeometry(size.x, size.y);
  const wall3 = new THREE.Mesh(wallGeo2, wallMat);
  wall3.position.set(0, size.y/2, -size.z/2);
  group.add(wall3);

  const wall4 = new THREE.Mesh(wallGeo2, wallMat);
  wall4.position.set(0, size.y/2, size.z/2);
  wall4.rotation.y = Math.PI;
  group.add(wall4);

  // small random props placeholder (boxes) — procedural but simple
  const propCount = rndInt(rng, 0, Math.min(12, Math.floor((size.x*size.z)/20)));
  for(let i=0;i<propCount;i++){
    const pw = rndRange(rng, 0.2, 1.2);
    const ph = rndRange(rng, 0.2, 1.2);
    const pd = rndRange(rng, 0.2, 1.2);
    const px = rndRange(rng, -size.x/2 + pw, size.x/2 - pw);
    const pz = rndRange(rng, -size.z/2 + pd, size.z/2 - pd);
    const box = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), new THREE.MeshStandardMaterial({color:0x444444}));
    box.position.set(px, ph/2, pz);
    group.add(box);
  }
}

// ---------- Chunk Manager ----------
const ChunkManager = {
  nodes: Nodes,
  entryNodeId: null,
  generateInitial(entryPos, entryForward){
    // create a start node at index 0
    nextNodeIndex = 1;
    Nodes.clear();
    const startIndex = nextNodeIndex++;
    const startNode = createNode('rectroom', entryPos.clone(), entryForward.clone(), startIndex);
    startNode.group.name = 'node_' + startNode.id;
    scene.add(startNode.group);
    Nodes.set(startNode.id, startNode);
    this.entryNodeId = startNode.id;
    currentNodeId = startNode.id;

    // generate ahead
    this.ensureAhead(camera.position);
  },
  ensureAhead(playerPos){
    // Ensure there are at least TARGET_AHEAD nodes ahead of current node along graph (we'll create a linear chain for now)
    // Determine the furthest generated node in the forward chain
    let furthest = null;
    Nodes.forEach(n => { if(!furthest || n.id > furthest.id) furthest = n; });
    let countAhead = 0;
    if(furthest){
      // estimate count ahead by nodes with id > currentNodeId
      Nodes.forEach(n=>{ if(n.id > currentNodeId) countAhead++; });
    }

    while(countAhead < TARGET_AHEAD){
      const last = furthest || Nodes.get(this.entryNodeId);
      const nextDir = last.forward.clone();
      // small random yaw
      const ang = (rndRange(RNG, -0.35, 0.35));
      nextDir.applyAxisAngle(new THREE.Vector3(0,1,0), ang);

      // choose type probabilistically: hallways more common
      const choice = rndRange(RNG, 0,1);
      const type = choice < 0.6 ? 'hallway' : 'rectroom';

      // position next node at the end of last node bounding box + small gap
      const lastBox = last.bbox.clone();
      const endPoint = new THREE.Vector3();
      // approximate forward endpoint: move along forward by half size (or length)
      const moveDist = (last.type === 'hallway') ? last.length : Math.max(last.size.x, last.size.z)/2 + 3;
      endPoint.copy(last.position).add(last.forward.clone().normalize().multiplyScalar(moveDist + 2));

      const index = nextNodeIndex++;
      const nn = createNode(type, endPoint, nextDir, index);
      nn.group.name = 'node_' + nn.id;
      scene.add(nn.group);
      Nodes.set(nn.id, nn);

      furthest = nn;
      countAhead++;
    }
  },
  update(playerPos){
    // unload nodes far behind player
    const toRemove = [];
    Nodes.forEach((node, id)=>{
      const d = node.position.distanceTo(playerPos);
      if(d > UNLOAD_DISTANCE){
        toRemove.push(id);
      }
    });
    toRemove.forEach(id=>{
      const node = Nodes.get(id);
      if(!node) return;
      // dispose resources
      node.group.traverse(o=>{
        if(o.isMesh){
          if(o.geometry) o.geometry.dispose();
          if(o.material){
            if(Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material.dispose();
          }
        }
      });
      // dispose textures
      if(node.textures){ node.textures.forEach(t=>{ if(t) t.dispose(); }); }
      scene.remove(node.group);
      Nodes.delete(id);
    });

    // ensure we have nodes ahead
    this.ensureAhead(playerPos);
  }
};

// ---------- Integration: when door opens ----------
function initializeLeviathanComplex(){
  console.log('Initializing Leviathan Complex — generating nodes.');
  // clear threshold objects similar to Phase 1, but keep camera and light
  scene.traverse((o)=>{
    if(o.isMesh){
      if(o.geometry) o.geometry.dispose();
      if(o.material) { if(Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material.dispose(); }
    }
  });
  // remove everything except camera (which is parented to scene) — easier to recreate a fresh scene
  while(scene.children.length) scene.remove(scene.children[0]);
  // re-add camera and lights
  scene.add(camera);
  const ambient = new THREE.AmbientLight(0x222222, 0.6);
  scene.add(ambient);

  // determine entry point just in front of camera
  const entryPos = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(2));
  const entryForward = camera.getWorldDirection(new THREE.Vector3()).clone();

  // start chunk manager
  ChunkManager.generateInitial(entryPos, entryForward);
}

// ---------- Previously defined Threshold utilities (kept for reference) ----------
function buildThreshold(){
  // (same as Phase 1) a long hallway to serve as the spawn
  const wallpaperTex = createWallpaperTexture();
  wallpaperTex.wrapS = wallpaperTex.wrapT = THREE.RepeatWrapping;
  wallpaperTex.repeat.set(2,2);

  const floorTex = createFloorTexture();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(8,8);

  const carpetTex = createCarpetTexture();
  carpetTex.wrapS = carpetTex.wrapT = THREE.RepeatWrapping;
  carpetTex.repeat.set(8,1);

  const doorTex = createDoorTexture();
  doorTex.wrapS = doorTex.wrapT = THREE.RepeatWrapping;

  const wallMat = new THREE.MeshPhongMaterial({ map: wallpaperTex });
  const floorMat = new THREE.MeshPhongMaterial({ map: floorTex });
  const carpetMat = new THREE.MeshPhongMaterial({ map: carpetTex });
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, metalness:0.1, roughness:0.8 });

  const corridorGroup = new THREE.Group();

  const segmentCount = 18;
  const segmentLength = 10;
  const corridorWidth = 4.0;
  const corridorHeight = 3.0;

  for(let i=0;i<segmentCount;i++){
    const z = -i * segmentLength;
    const wallGeo = new THREE.BoxGeometry(segmentLength, corridorHeight, 0.1);
    const wallLeft = new THREE.Mesh(wallGeo, wallMat);
    wallLeft.position.set(-corridorWidth/2 - 0.05, corridorHeight/2, z - segmentLength/2);
    wallLeft.rotation.y = Math.PI/2;
    corridorGroup.add(wallLeft);

    const wallRight = new THREE.Mesh(wallGeo, wallMat);
    wallRight.position.set(corridorWidth/2 + 0.05, corridorHeight/2, z - segmentLength/2);
    wallRight.rotation.y = -Math.PI/2;
    corridorGroup.add(wallRight);

    const floorGeo = new THREE.PlaneGeometry(corridorWidth, segmentLength);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI/2;
    floorMesh.position.set(0,0,z - segmentLength/2);
    corridorGroup.add(floorMesh);

    const carpetWidth = corridorWidth * 0.6;
    const carpetGeo = new THREE.PlaneGeometry(carpetWidth, segmentLength);
    const carpetMesh = new THREE.Mesh(carpetGeo, carpetMat);
    carpetMesh.rotation.x = -Math.PI/2;
    carpetMesh.position.set(0,0.01,z - segmentLength/2);
    corridorGroup.add(carpetMesh);

    const ceilGeo = new THREE.PlaneGeometry(corridorWidth, segmentLength);
    const ceilMesh = new THREE.Mesh(ceilGeo, wallMat);
    ceilMesh.rotation.x = Math.PI/2;
    ceilMesh.position.set(0,corridorHeight,z - segmentLength/2);
    corridorGroup.add(ceilMesh);

    if(i>1){
      const doorHeight = 2.1;
      const doorWidth = 0.9;
      const doorGeo = new THREE.BoxGeometry(doorWidth, doorHeight, 0.06);
      const leftDoor = new THREE.Mesh(doorGeo, doorMat);
      leftDoor.position.set(-corridorWidth/2 + doorWidth/2 + 0.02, doorHeight/2, z - segmentLength/2 + 0.5);
      leftDoor.userData = { isDoor:true, side:'left', open:false };
      const leftPivot = new THREE.Object3D();
      leftPivot.position.copy(leftDoor.position);
      leftDoor.position.set(doorWidth/2,0,0);
      leftPivot.add(leftDoor);
      leftPivot.userData = { doorObject:leftDoor };
      corridorGroup.add(leftPivot);
      interactiveObjects.push(leftPivot);

      const rightDoor = new THREE.Mesh(doorGeo, doorMat);
      rightDoor.position.set(corridorWidth/2 - doorWidth/2 - 0.02, doorHeight/2, z - segmentLength/2 - 0.5);
      rightDoor.userData = { isDoor:true, side:'right', open:false };
      const rightPivot = new THREE.Object3D();
      rightPivot.position.copy(rightDoor.position);
      rightDoor.position.set(-doorWidth/2,0,0);
      rightPivot.add(rightDoor);
      rightPivot.userData = { doorObject:rightDoor };
      corridorGroup.add(rightPivot);
      interactiveObjects.push(rightPivot);
    }
  }

  corridorGroup.position.set(0,0,0);
  scene.add(corridorGroup);
  scene.fog = new THREE.FogExp2(0x000000, 0.0006);
}

// ---------- Input / Interaction / Movement (kept from Phase 1) ----------
function setupPointerLock(){
  const blocker = document.getElementById('instructions');
  document.addEventListener('click', () => {
    if(document.pointerLockElement !== renderer.domElement){
      renderer.domElement.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    const pl = document.pointerLockElement === renderer.domElement;
    blocker.style.opacity = pl ? '0' : '1';
    blocker.style.pointerEvents = pl ? 'none' : 'auto';
  });

  let euler = new THREE.Euler(0,0,0,'YXZ');
  let PI_2 = Math.PI/2;
  document.addEventListener('mousemove', (event) => {
    if(document.pointerLockElement !== renderer.domElement) return;
    const movementX = event.movementX || 0;
    const movementY = event.movementY || 0;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= movementX * 0.002;
    euler.x -= movementY * 0.002;
    euler.x = Math.max( - PI_2 + 0.01, Math.min( PI_2 - 0.01, euler.x ) );
    camera.quaternion.setFromEuler(euler);
  });
}

function setupInput(){
  const onKeyDown = function ( event ) {
    switch ( event.code ) {
      case 'ArrowUp':
      case 'KeyW': controls.moveForward = true; break;
      case 'ArrowLeft':
      case 'KeyA': controls.moveLeft = true; break;
      case 'ArrowDown':
      case 'KeyS': controls.moveBackward = true; break;
      case 'ArrowRight':
      case 'KeyD': controls.moveRight = true; break;
      case 'Space': if(controls.canJump) { controls.velocity.y += 5; controls.canJump = false; } break;
      case 'KeyE': handleInteract(); break;
    }
  };

  const onKeyUp = function ( event ) {
    switch ( event.code ) {
      case 'ArrowUp':
      case 'KeyW': controls.moveForward = false; break;
      case 'ArrowLeft':
      case 'KeyA': controls.moveLeft = false; break;
      case 'ArrowDown':
      case 'KeyS': controls.moveBackward = false; break;
      case 'ArrowRight':
      case 'KeyD': controls.moveRight = false; break;
    }
  };

  document.addEventListener( 'keydown', onKeyDown );
  document.addEventListener( 'keyup', onKeyUp );
}

function handleInteract(){
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  raycaster.set(camera.position, camDir);
  const intersects = raycaster.intersectObjects(interactiveObjects, true);
  if(intersects.length>0){
    const obj = intersects[0].object;
    const pivot = findParentPivot(obj);
    if(pivot && pivot.userData && pivot.userData.doorObject){
      toggleDoor(pivot);
    }
  }
}

function findParentPivot(obj){
  let o = obj;
  for(let i=0;i<6;i++){
    if(!o) return null;
    if(o.userData && o.userData.doorObject) return o;
    o = o.parent;
  }
  return null;
}

function toggleDoor(pivot){
  const door = pivot.userData.doorObject;
  if(!door) return;
  const isOpen = door.userData.open;
  const start = performance.now();
  const duration = 300;
  const from = pivot.rotation.y;
  const to = door.userData.side === 'left' ? (isOpen ? 0 : Math.PI/2) : (isOpen ? 0 : -Math.PI/2);
  door.userData.open = !isOpen;

  function tick(){
    const t = Math.min(1, (performance.now()-start)/duration);
    pivot.rotation.y = from + (to-from) * easeOutCubic(t);
    if(t < 1) requestAnimationFrame(tick);
    else {
      if(!isOpen){
        initializeLeviathanComplex();
      }
    }
  }
  tick();
}
function easeOutCubic(t){ return 1 - Math.pow(1-t,3); }

// ---------- Textures reused from Phase 1 ----------
function createWallpaperTexture(){
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e6d8b5';
  ctx.fillRect(0,0,size,size);
  ctx.fillStyle = 'rgba(220,200,150,0.06)';
  for(let i=0;i<20;i++){
    const x = i * (size/20) + Math.random()*6;
    ctx.fillRect(x,0,Math.random()*6 + 2, size);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.02)';
  for(let i=0;i<3000;i++){
    const x = Math.random()*size;
    const y = Math.random()*size;
    ctx.fillRect(x,y,1,1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function createFloorTexture(){
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c9b59a';
  ctx.fillRect(0,0,size,size);
  ctx.strokeStyle = 'rgba(110,80,50,0.08)';
  ctx.lineWidth = 2;
  for(let i=0;i<16;i++){
    const y = i * (size/16) + 2;
    ctx.beginPath();
    ctx.moveTo(0,y);
    ctx.lineTo(size,y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.03)';
  for(let i=0;i<2000;i++) ctx.fillRect(Math.random()*size, Math.random()*size,1,1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function createCarpetTexture(){
  const w = 256, h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b85c55';
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  for(let i=0;i<2000;i++){
    const x = Math.random()*w;
    const y = Math.random()*h;
    ctx.fillRect(x,y,1,1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}
function createDoorTexture(){
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(0,0,size,size);
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(60,60,size-120,size-120);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  for(let i=0;i<200;i++){
    const x = Math.random()*size;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x + Math.random()*3 -1.5,size); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

// ---------- Animation loop & updates ----------
function onWindowResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate(){
  requestAnimationFrame(animate);
  const time = performance.now();
  const delta = (time - prevTime) / 1000;

  controls.velocity.x -= controls.velocity.x * 10.0 * delta;
  controls.velocity.z -= controls.velocity.z * 10.0 * delta;
  controls.velocity.y -= 9.8 * 5.0 * delta;

  controls.direction.z = Number( controls.moveForward ) - Number( controls.moveBackward );
  controls.direction.x = Number( controls.moveRight ) - Number( controls.moveLeft );
  controls.direction.normalize();

  const speed = 5.0;
  if(controls.moveForward || controls.moveBackward) controls.velocity.z -= controls.direction.z * speed * delta;
  if(controls.moveLeft || controls.moveRight) controls.velocity.x -= controls.direction.x * speed * delta;

  const move = new THREE.Vector3(controls.velocity.x, controls.velocity.y, controls.velocity.z).multiplyScalar(delta);
  const quat = camera.quaternion.clone();
  const moveWorld = move.applyQuaternion(quat);
  camera.position.add(moveWorld);

  if(camera.position.y < 1.6){
    controls.velocity.y = 0;
    camera.position.y = 1.6;
    controls.canJump = true;
  }

  // Update chunk manager periodically (every frame is fine for this prototype)
  ChunkManager.update(camera.position);

  prevTime = time;
  renderer.render(scene, camera);
}

// ---------- Expose debugging handle ----------
window._Leviathan = {
  scene,
  camera,
  renderer,
  ChunkManager,
  GlobalSeed,
};
