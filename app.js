import * as THREE from 'https://unpkg.com/three@0.152.2/build/three.module.js';

// Phase 1 scaffold for The Leviathan Complex — The Threshold scene
// - Pointer lock + WASD movement
// - Long hallway with wallpaper, carpet center, and green doors
// - Doors interactable with 'E' to open; opening triggers initializeLeviathanComplex()
// - All textures generated via canvas at runtime (no external assets)

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
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0,1.6,0);

  // lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.75); // semi-well lit, cold-ish later tweak
  scene.add(ambient);

  playerLight = new THREE.PointLight(0xfff9e0, 0.5, 20, 2);
  camera.add(playerLight);
  scene.add(camera);

  // raycaster for interactions
  raycaster = new THREE.Raycaster();

  // build the threshold hallway
  buildThreshold();

  // pointer lock and input
  setupPointerLock();
  setupInput();

  window.addEventListener('resize', onWindowResize);
}

function buildThreshold(){
  // create textures
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

  // materials
  const wallMat = new THREE.MeshPhongMaterial({ map: wallpaperTex });
  const floorMat = new THREE.MeshPhongMaterial({ map: floorTex });
  const carpetMat = new THREE.MeshPhongMaterial({ map: carpetTex });
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, metalness:0.1, roughness:0.8 });

  const corridorGroup = new THREE.Group();

  // build repeated segments to give an "infinite" hallway feeling
  const segmentCount = 30; // long hallway; can be extended
  const segmentLength = 10; // meters
  const corridorWidth = 4.0;
  const corridorHeight = 3.0;

  for(let i=0;i<segmentCount;i++){
    const z = -i * segmentLength;
    // walls: left and right panels per segment
    const wallGeo = new THREE.BoxGeometry(segmentLength, corridorHeight, 0.1);
    const wallLeft = new THREE.Mesh(wallGeo, wallMat);
    wallLeft.position.set(-corridorWidth/2 - 0.05, corridorHeight/2, z - segmentLength/2);
    wallLeft.rotation.y = Math.PI/2;
    corridorGroup.add(wallLeft);

    const wallRight = new THREE.Mesh(wallGeo, wallMat);
    wallRight.position.set(corridorWidth/2 + 0.05, corridorHeight/2, z - segmentLength/2);
    wallRight.rotation.y = -Math.PI/2;
    corridorGroup.add(wallRight);

    // floor piece
    const floorGeo = new THREE.PlaneGeometry(corridorWidth, segmentLength);
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI/2;
    floorMesh.position.set(0,0,z - segmentLength/2);
    corridorGroup.add(floorMesh);

    // carpet centered 60% width
    const carpetWidth = corridorWidth * 0.6;
    const carpetGeo = new THREE.PlaneGeometry(carpetWidth, segmentLength);
    const carpetMesh = new THREE.Mesh(carpetGeo, carpetMat);
    carpetMesh.rotation.x = -Math.PI/2;
    carpetMesh.position.set(0,0.01,z - segmentLength/2); // slight offset to avoid z-fighting
    corridorGroup.add(carpetMesh);

    // ceiling
    const ceilGeo = new THREE.PlaneGeometry(corridorWidth, segmentLength);
    const ceilMesh = new THREE.Mesh(ceilGeo, wallMat);
    ceilMesh.rotation.x = Math.PI/2;
    ceilMesh.position.set(0,corridorHeight,z - segmentLength/2);
    corridorGroup.add(ceilMesh);

    // doors on both sides per segment (skip first to avoid spawn door)
    if(i>1){
      const doorHeight = 2.1;
      const doorWidth = 0.9;
      const doorGeo = new THREE.BoxGeometry(doorWidth, doorHeight, 0.06);

      // left door
      const leftDoor = new THREE.Mesh(doorGeo, doorMat);
      leftDoor.position.set(-corridorWidth/2 + doorWidth/2 + 0.02, doorHeight/2, z - segmentLength/2 + 0.5);
      leftDoor.userData = { isDoor:true, side:'left', open:false };
      // create a pivot for rotation (hinge at one side)
      const leftPivot = new THREE.Object3D();
      leftPivot.position.copy(leftDoor.position);
      leftDoor.position.set(doorWidth/2,0,0); // relative to pivot
      leftPivot.add(leftDoor);
      leftPivot.userData = { doorObject:leftDoor };
      corridorGroup.add(leftPivot);
      interactiveObjects.push(leftPivot);

      // right door
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

  // place corridor so that camera spawns near the start
  corridorGroup.position.set(0,0,0);
  scene.add(corridorGroup);

  // subtle ambient fog to sell scale
  scene.fog = new THREE.FogExp2(0x000000, 0.0006);
}

function createWallpaperTexture(){
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  // base beige-yellow
  ctx.fillStyle = '#e6d8b5';
  ctx.fillRect(0,0,size,size);
  // add vertical subtle stripes
  ctx.fillStyle = 'rgba(220,200,150,0.06)';
  for(let i=0;i<20;i++){
    const x = i * (size/20) + Math.random()*6;
    ctx.fillRect(x,0,Math.random()*6 + 2, size);
  }
  // light noise
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
  // wooden floor base (light grey-beige)
  ctx.fillStyle = '#c9b59a';
  ctx.fillRect(0,0,size,size);
  // wood planks lines
  ctx.strokeStyle = 'rgba(110,80,50,0.08)';
  ctx.lineWidth = 2;
  for(let i=0;i<16;i++){
    const y = i * (size/16) + 2;
    ctx.beginPath();
    ctx.moveTo(0,y);
    ctx.lineTo(size,y);
    ctx.stroke();
  }
  // noise
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
  ctx.fillStyle = '#b85c55'; // light red carpet
  ctx.fillRect(0,0,w,h);
  // subtle pattern
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
  // green wooden door base
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(0,0,size,size);
  // panels
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(60,60,size-120,size-120);
  // wood grain lines
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  for(let i=0;i<200;i++){
    const x = Math.random()*size;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x + Math.random()*3 -1.5,size); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

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

  // mouse look
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
  // raycast from camera forward
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  raycaster.set(camera.position, camDir);
  const intersects = raycaster.intersectObjects(interactiveObjects, true);
  if(intersects.length>0){
    const obj = intersects[0].object;
    // pivot might be in the selection chain
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
  // animate rotation over 300ms
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
      // if door just opened, trigger the generation start
      if(!isOpen){
        initializeLeviathanComplex();
      }
    }
  }
  tick();
}

function easeOutCubic(t){ return 1 - Math.pow(1-t,3); }

function initializeLeviathanComplex(){
  console.log('Door opened — initializing Leviathan Complex (placeholder).');
  // For Phase 1 we simply display a brief UI hint and fade the threshold out
  const overlay = document.createElement('div');
  overlay.style.position='fixed'; overlay.style.left='0'; overlay.style.top='0'; overlay.style.width='100%'; overlay.style.height='100%';
  overlay.style.background='rgba(0,0,0,0)'; overlay.style.transition='background 1s';
  document.body.appendChild(overlay);
  requestAnimationFrame(()=>{ overlay.style.background='rgba(0,0,0,0.6)'; });

  // TODO: replace the threshold with procedural generator entrance
  // For now remove corridor geometry after timeout to simulate transition
  setTimeout(()=>{
    // unload threshold objects (simple disposal placeholder)
    scene.traverse((o)=>{
      if(o.isMesh){
        if(o.geometry) o.geometry.dispose();
        if(o.material){
          if(Array.isArray(o.material)) o.material.forEach(m=>m.dispose()); else o.material.dispose();
        }
      }
    });
    scene.clear();
    scene.background = new THREE.Color(0x050606);
    // re-add camera and light
    scene.add(camera);
    scene.add(new THREE.AmbientLight(0x222222,0.6));
    const hint = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({color:0xffffff}));
    // placeholder node
    scene.add(hint);
  }, 800);
}

function onWindowResize(){
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate(){
  requestAnimationFrame(animate);
  const time = performance.now();
  const delta = (time - prevTime) / 1000;

  // simple movement physics
  controls.velocity.x -= controls.velocity.x * 10.0 * delta;
  controls.velocity.z -= controls.velocity.z * 10.0 * delta;
  controls.velocity.y -= 9.8 * 5.0 * delta; // gravity placeholder

  controls.direction.z = Number( controls.moveForward ) - Number( controls.moveBackward );
  controls.direction.x = Number( controls.moveRight ) - Number( controls.moveLeft );
  controls.direction.normalize();

  const speed = 5.0;
  if(controls.moveForward || controls.moveBackward) controls.velocity.z -= controls.direction.z * speed * delta;
  if(controls.moveLeft || controls.moveRight) controls.velocity.x -= controls.direction.x * speed * delta;

  // apply movement relative to camera rotation
  const move = new THREE.Vector3(controls.velocity.x, controls.velocity.y, controls.velocity.z).multiplyScalar(delta);
  const quat = camera.quaternion.clone();
  const moveWorld = move.applyQuaternion(quat);
  camera.position.add(moveWorld);

  // keep player on floor (simple ground clamp for Threshold)
  if(camera.position.y < 1.6){
    controls.velocity.y = 0;
    camera.position.y = 1.6;
    controls.canJump = true;
  }

  prevTime = time;

  renderer.render(scene, camera);
}

// --- Utility / stubs for Phase 2+ ---

// Chunk manager stub: will be responsible for generating nodes ahead and unloading behind.
const ChunkManager = {
  // keep a registry of generated nodes
  nodes: new Map(),
  generateAhead(playerPos, forwardDir){
    // placeholder
    console.log('ChunkManager.generateAhead called — implement graph-based procedural generation here.');
  },
  unloadBehind(playerPos){
    // placeholder for disposal logic (geometry.dispose(), material.dispose())
    console.log('ChunkManager.unloadBehind called');
  }
};

// Expose some debug helpers to window for development
window._Leviathan = {
  scene,
  camera,
  renderer,
  ChunkManager,
};
