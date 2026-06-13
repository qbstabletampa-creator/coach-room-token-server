import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let scene, camera, renderer, controls;
let humanoid = null;
let isInitialized = false;
let containerEl = null;
let modelLoaded = false;

let gltfScene = null;
let gltfTextures = [];

const LANDMARKS = {
  NOSE: 0,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

const SLERP_FACTOR = 0.4;

const _quat = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _v3A = new THREE.Vector3();
const _v3B = new THREE.Vector3();
const _v3C = new THREE.Vector3();

let bones = {};
let restQuaternions = {};
let restDirections = {};
let prevBoneQuaternions = {};

// ==========================================
// setFromUnitVectors bone rotation
// ==========================================

// Bone-to-landmark mapping: which landmarks define each bone's direction
const BONE_LANDMARK_MAP = {
  spine:        { from: 'hipMid', to: 'shoulderMid' },
  spine1:       { from: 'hipMid', to: 'shoulderMid' },
  spine2:       { from: 'hipMid', to: 'shoulderMid' },
  neck:         { from: 'shoulderMid', to: 'headMid' },
  head:         { from: 'shoulderMid', to: 'headMid' },
  leftArm:      { from: LANDMARKS.LEFT_SHOULDER, to: LANDMARKS.LEFT_ELBOW },
  leftForeArm:  { from: LANDMARKS.LEFT_ELBOW, to: LANDMARKS.LEFT_WRIST },
  rightArm:     { from: LANDMARKS.RIGHT_SHOULDER, to: LANDMARKS.RIGHT_ELBOW },
  rightForeArm: { from: LANDMARKS.RIGHT_ELBOW, to: LANDMARKS.RIGHT_WRIST },
  leftUpLeg:    { from: LANDMARKS.LEFT_HIP, to: LANDMARKS.LEFT_KNEE },
  leftLeg:      { from: LANDMARKS.LEFT_KNEE, to: LANDMARKS.LEFT_ANKLE },
  rightUpLeg:   { from: LANDMARKS.RIGHT_HIP, to: LANDMARKS.RIGHT_KNEE },
  rightLeg:     { from: LANDMARKS.RIGHT_KNEE, to: LANDMARKS.RIGHT_ANKLE },
};

// Per-bone slerp factors (lower = smoother but laggier)
const BONE_SLERP = {
  hips: 0.3,
  spine: 0.3, spine1: 0.3, spine2: 0.3,
  neck: 0.4, head: 0.4,
  leftArm: 0.5, leftForeArm: 0.5,
  rightArm: 0.5, rightForeArm: 0.5,
  leftUpLeg: 0.4, leftLeg: 0.4,
  rightUpLeg: 0.4, rightLeg: 0.4,
};

function computeRestDirections() {
  // Compute the rest-pose direction of each bone in its PARENT's local space.
  // This is what setFromUnitVectors rotates FROM.
  restDirections = {};

  for (const [boneKey, bone] of Object.entries(bones)) {
    if (!bone.children.length && !BONE_LANDMARK_MAP[boneKey]) continue;

    // Get this bone's world position
    const boneWorldPos = new THREE.Vector3();
    bone.getWorldPosition(boneWorldPos);

    // Get child bone world position (the "tip" of this bone)
    let childWorldPos = null;

    // For bones with a known child in our map, find it
    const childKeys = Object.entries(BONE_LANDMARK_MAP).filter(([, v]) => {
      // Find bones whose parent in the skeleton is this bone
      return false; // We'll use a different approach
    });

    // Use the first bone child as the tip direction
    for (const child of bone.children) {
      if (child.isBone) {
        childWorldPos = new THREE.Vector3();
        child.getWorldPosition(childWorldPos);
        break;
      }
    }

    if (!childWorldPos) continue;

    // Direction in world space
    const worldDir = new THREE.Vector3().subVectors(childWorldPos, boneWorldPos).normalize();

    // Transform to parent-local space
    const parentWorldQuat = new THREE.Quaternion();
    if (bone.parent) {
      bone.parent.getWorldQuaternion(parentWorldQuat);
    }
    const parentWorldQuatInv = parentWorldQuat.clone().invert();
    const localDir = worldDir.applyQuaternion(parentWorldQuatInv).normalize();

    restDirections[boneKey] = localDir;
  }

  console.log('[QB Motion] Rest directions computed for:', Object.keys(restDirections).join(', '));
}

function rotateBone(boneKey, fromPos, toPos) {
  const bone = bones[boneKey];
  if (!bone) return;

  const restDir = restDirections[boneKey];
  if (!restDir) return;

  // Compute target direction in world space from world landmarks
  _v3A.set(toPos.x - fromPos.x, toPos.y - fromPos.y, toPos.z - fromPos.z).normalize();

  // Transform target direction into parent-local space
  const parentWorldQuat = _quatB;
  if (bone.parent) {
    bone.parent.getWorldQuaternion(parentWorldQuat);
  } else {
    parentWorldQuat.identity();
  }
  const parentInv = _quat.copy(parentWorldQuat).invert();
  _v3A.applyQuaternion(parentInv).normalize();

  // Compute rotation from rest direction to target direction
  const rotQuat = new THREE.Quaternion().setFromUnitVectors(restDir, _v3A);

  // Apply on top of rest quaternion
  const rest = restQuaternions[boneKey];
  if (!rest) return;

  const targetQuat = rotQuat.multiply(rest);

  // Slerp for smoothing
  const slerpFactor = BONE_SLERP[boneKey] || SLERP_FACTOR;
  if (prevBoneQuaternions[boneKey]) {
    prevBoneQuaternions[boneKey].slerp(targetQuat, slerpFactor);
    bone.quaternion.copy(prevBoneQuaternions[boneKey]);
  } else {
    prevBoneQuaternions[boneKey] = targetQuat.clone();
    bone.quaternion.copy(targetQuat);
  }
}

// ==========================================
// Public API
// ==========================================

export function init3D(container) {
  if (isInitialized) dispose3D();
  containerEl = container;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.2, 2.5);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  container.innerHTML = '';
  container.appendChild(renderer.domElement);
  resize3D();

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;
  pmremGenerator.dispose();

  const ambient = new THREE.AmbientLight(0x404050, 1.8);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
  keyLight.position.set(3, 5, 4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 20;
  keyLight.shadow.camera.left = -3;
  keyLight.shadow.camera.right = 3;
  keyLight.shadow.camera.top = 3;
  keyLight.shadow.camera.bottom = -3;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8899cc, 0.6);
  fillLight.position.set(-3, 2, -2);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xD4C36A, 0.4);
  rimLight.position.set(0, 1, -4);
  scene.add(rimLight);

  const groundGeo = new THREE.PlaneGeometry(10, 10);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(6, 30, 0x222222, 0x1a1a1a);
  grid.position.y = -1.5;
  scene.add(grid);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 8;
  controls.target.set(0, 0, 0);
  controls.addEventListener('change', render);

  isInitialized = true;

  loadMannequin();
  render();
}

export function resize3D() {
  if (!renderer || !containerEl) return;
  const w = containerEl.clientWidth;
  const h = containerEl.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function update3DPose(landmarks, worldLandmarks) {
  if (!isInitialized || !modelLoaded) return;

  // Prefer world landmarks (metric 3D, Y-up) for bone rotation
  // Fall back to normalized landmarks with coordinate conversion
  const wl = worldLandmarks || null;

  if (wl) {
    updateFromWorldLandmarks(wl);
  } else if (landmarks) {
    updateFromNormalizedLandmarks(landmarks);
  }

  render();
}

function updateFromWorldLandmarks(wl) {
  // MediaPipe world landmarks: X right, Y up, Z toward camera (right-handed)
  // Three.js: same convention. Direct use.
  const ls = wl[LANDMARKS.LEFT_SHOULDER];
  const rs = wl[LANDMARKS.RIGHT_SHOULDER];
  const le = wl[LANDMARKS.LEFT_ELBOW];
  const re = wl[LANDMARKS.RIGHT_ELBOW];
  const lw = wl[LANDMARKS.LEFT_WRIST];
  const rw = wl[LANDMARKS.RIGHT_WRIST];
  const lh = wl[LANDMARKS.LEFT_HIP];
  const rh = wl[LANDMARKS.RIGHT_HIP];
  const lk = wl[LANDMARKS.LEFT_KNEE];
  const rk = wl[LANDMARKS.RIGHT_KNEE];
  const la = wl[LANDMARKS.LEFT_ANKLE];
  const ra = wl[LANDMARKS.RIGHT_ANKLE];
  const nose = wl[LANDMARKS.NOSE];
  const leftEar = wl[LANDMARKS.LEFT_EAR];
  const rightEar = wl[LANDMARKS.RIGHT_EAR];

  if (!ls || !rs || !lh || !rh) return;

  if (humanoid && !humanoid.visible) {
    humanoid.visible = true;
  }

  // Compute midpoints
  const shoulderMid = {
    x: (ls.x + rs.x) * 0.5,
    y: (ls.y + rs.y) * 0.5,
    z: (ls.z + rs.z) * 0.5,
  };
  const hipMid = {
    x: (lh.x + rh.x) * 0.5,
    y: (lh.y + rh.y) * 0.5,
    z: (lh.z + rh.z) * 0.5,
  };

  let headMid = null;
  if (leftEar && rightEar) {
    headMid = {
      x: (leftEar.x + rightEar.x) * 0.5,
      y: (leftEar.y + rightEar.y) * 0.5,
      z: (leftEar.z + rightEar.z) * 0.5,
    };
  } else if (nose) {
    headMid = { x: nose.x, y: nose.y + 0.05, z: nose.z };
  }

  if (_skipBoneRotation) return;

  // === HIPS: rotation only, keep model grounded ===
  if (bones.hips) {
    // Use setFromUnitVectors for hips spine direction
    rotateBone('hips', hipMid, shoulderMid);
  }

  humanoid.updateMatrixWorld(true);

  // === SPINE chain ===
  rotateBone('spine', hipMid, shoulderMid);
  rotateBone('spine1', hipMid, shoulderMid);
  rotateBone('spine2', hipMid, shoulderMid);
  humanoid.updateMatrixWorld(true);

  // === NECK & HEAD ===
  if (headMid) {
    rotateBone('neck', shoulderMid, headMid);
    rotateBone('head', shoulderMid, headMid);
  }
  humanoid.updateMatrixWorld(true);

  // === ARMS ===
  if (le) rotateBone('leftArm', ls, le);
  humanoid.updateMatrixWorld(true);
  if (lw) rotateBone('leftForeArm', le, lw);

  if (re) rotateBone('rightArm', rs, re);
  humanoid.updateMatrixWorld(true);
  if (rw) rotateBone('rightForeArm', re, rw);
  humanoid.updateMatrixWorld(true);

  // === LEGS ===
  if (lk) rotateBone('leftUpLeg', lh, lk);
  humanoid.updateMatrixWorld(true);
  if (la) rotateBone('leftLeg', lk, la);

  if (rk) rotateBone('rightUpLeg', rh, rk);
  humanoid.updateMatrixWorld(true);
  if (ra) rotateBone('rightLeg', rk, ra);

  // Update orbit target to follow the model's chest area
  if (controls && bones.spine2) {
    bones.spine2.getWorldPosition(_v3A);
    controls.target.lerp(_v3A, 0.05);
    controls.update();
  }
}

function updateFromNormalizedLandmarks(landmarks) {
  // Convert normalized (0-1, Y-down) to pseudo-world (meters-ish, Y-up)
  // This is the fallback when world landmarks aren't available
  const wl = landmarks.map(lm => {
    if (!lm) return null;
    return {
      x: (lm.x - 0.5) * 2,
      y: -(lm.y - 0.5) * 2,
      z: -(lm.z || 0) * 2,
      visibility: lm.visibility || 0,
    };
  });
  updateFromWorldLandmarks(wl);
}

export function dispose3D() {
  if (controls) {
    controls.removeEventListener('change', render);
    controls.dispose();
    controls = null;
  }
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
    renderer = null;
  }
  if (gltfScene) {
    gltfScene.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    gltfScene = null;
  }
  for (const tex of gltfTextures) {
    tex.dispose();
  }
  gltfTextures = [];
  if (scene && scene.environment) {
    scene.environment.dispose();
  }
  scene = null;
  camera = null;
  humanoid = null;
  isInitialized = false;
  modelLoaded = false;
  bones = {};
  restQuaternions = {};
  restDirections = {};
  prevBoneQuaternions = {};
}

export function debugShowRestPose() {
  if (humanoid) {
    humanoid.visible = true;
    prevBoneQuaternions = {};
    for (const [key, bone] of Object.entries(bones)) {
      if (restQuaternions[key]) {
        bone.quaternion.copy(restQuaternions[key]);
      }
    }
    humanoid.position.set(0, -1.0, 0);
    humanoid.updateMatrixWorld(true);
    render();
  }
}

let _skipBoneRotation = false;
export function setSkipBoneRotation(skip) { _skipBoneRotation = skip; }

export function isWebGLAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

// ==========================================
// Render (on-demand, no animation loop)
// ==========================================

let renderPending = false;
function render() {
  if (!renderer || !scene || !camera || renderPending) return;
  renderPending = true;
  controls?.update();
  renderer.render(scene, camera);
  renderPending = false;
}

// ==========================================
// GLTF Mannequin Loading
// ==========================================

const BONE_NAME_PATTERNS = {
  hips:          ['mixamorigHips', 'mixamorig:Hips', 'Hips'],
  spine:         ['mixamorigSpine', 'mixamorig:Spine', 'Spine'],
  spine1:        ['mixamorigSpine1', 'mixamorig:Spine1', 'Spine1'],
  spine2:        ['mixamorigSpine2', 'mixamorig:Spine2', 'Spine2'],
  neck:          ['mixamorigNeck', 'mixamorig:Neck', 'Neck'],
  head:          ['mixamorigHead', 'mixamorig:Head', 'Head'],
  leftShoulder:  ['mixamorigLeftShoulder', 'mixamorig:LeftShoulder', 'LeftShoulder'],
  leftArm:       ['mixamorigLeftArm', 'mixamorig:LeftArm', 'LeftArm'],
  leftForeArm:   ['mixamorigLeftForeArm', 'mixamorig:LeftForeArm', 'LeftForeArm'],
  leftHand:      ['mixamorigLeftHand', 'mixamorig:LeftHand', 'LeftHand'],
  rightShoulder: ['mixamorigRightShoulder', 'mixamorig:RightShoulder', 'RightShoulder'],
  rightArm:      ['mixamorigRightArm', 'mixamorig:RightArm', 'RightArm'],
  rightForeArm:  ['mixamorigRightForeArm', 'mixamorig:RightForeArm', 'RightForeArm'],
  rightHand:     ['mixamorigRightHand', 'mixamorig:RightHand', 'RightHand'],
  leftUpLeg:     ['mixamorigLeftUpLeg', 'mixamorig:LeftUpLeg', 'LeftUpLeg'],
  leftLeg:       ['mixamorigLeftLeg', 'mixamorig:LeftLeg', 'LeftLeg'],
  leftFoot:      ['mixamorigLeftFoot', 'mixamorig:LeftFoot', 'LeftFoot'],
  rightUpLeg:    ['mixamorigRightUpLeg', 'mixamorig:RightUpLeg', 'RightUpLeg'],
  rightLeg:      ['mixamorigRightLeg', 'mixamorig:RightLeg', 'RightLeg'],
  rightFoot:     ['mixamorigRightFoot', 'mixamorig:RightFoot', 'RightFoot'],
};

function findBone(root, patterns) {
  let found = null;
  for (const name of patterns) {
    root.traverse(child => {
      if (child.isBone && child.name === name && !found) {
        found = child;
      }
    });
    if (found) break;
  }
  return found;
}

function loadMannequin() {
  const loader = new GLTFLoader();

  loader.load(
    'mannequin.glb',
    (gltf) => {
      if (!scene) return;

      gltfScene = gltf.scene;

      if (gltf.animations && gltf.animations.length > 0) {
        console.log('[QB Motion] Ignoring', gltf.animations.length, 'embedded animation clips');
      }

      gltf.scene.traverse(child => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) {
            if (mat.map) gltfTextures.push(mat.map);
            if (mat.normalMap) gltfTextures.push(mat.normalMap);
            if (mat.roughnessMap) gltfTextures.push(mat.roughnessMap);
            if (mat.metalnessMap) gltfTextures.push(mat.metalnessMap);
          }
        }
      });

      const goldMaterial = new THREE.MeshStandardMaterial({
        color: 0xD4C36A,
        roughness: 0.35,
        metalness: 0.7,
      });

      gltf.scene.traverse(child => {
        if (child.isMesh) {
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.dispose());
            } else {
              child.material.dispose();
            }
          }
          child.material = goldMaterial;
          child.castShadow = true;
          child.frustumCulled = false;
        }
      });

      gltf.scene.scale.setScalar(1.0);
      gltf.scene.position.set(0, -1.0, 0);
      gltf.scene.visible = false;

      scene.add(gltf.scene);
      gltf.scene.updateMatrixWorld(true);

      // Find and store bone references
      bones = {};
      for (const [key, patterns] of Object.entries(BONE_NAME_PATTERNS)) {
        const bone = findBone(gltf.scene, patterns);
        if (bone) {
          bones[key] = bone;
        } else {
          console.warn('[QB Motion] Bone not found:', key, patterns);
        }
      }

      console.log('[QB Motion] Bones mapped:', Object.keys(bones).join(', '));

      // Capture rest-pose quaternions
      restQuaternions = {};
      for (const [key, bone] of Object.entries(bones)) {
        restQuaternions[key] = bone.quaternion.clone();
      }

      // Compute rest-pose bone directions from skeleton geometry
      computeRestDirections();

      humanoid = gltf.scene;
      modelLoaded = true;

      console.log('[QB Motion] Mannequin loaded (setFromUnitVectors mode)');
      render();
    },
    (progress) => {
      if (progress.total > 0) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        console.log('[QB Motion] Loading mannequin:', pct + '%');
      }
    },
    (error) => {
      console.error('[QB Motion] Failed to load mannequin:', error);
    }
  );
}
