import * as THREE from 'three';

(function () {
  'use strict';

  const canvas = document.getElementById('globe-canvas');
  if (!canvas) return;

  const PAGE = window.TERRAIN_POS || { x: 0, z: 0 };

  // ── Renderer ──
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping      = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.2;

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 600);

  const loader = new THREE.TextureLoader();

  // ── Sky — star field photo + warm Martian horizon glow ──
  const starTex = loader.load('bg/PIA17811~medium.jpg');
  starTex.wrapS = starTex.wrapT = THREE.RepeatWrapping;

  const sunDir = new THREE.Vector3(0.62, 0.14, -0.77).normalize();

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uStarMap: { value: starTex },
    },
    vertexShader: `
      varying vec3 vWorldDir;
      varying vec2 vUv;
      void main() {
        vWorldDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uStarMap;
      varying vec3 vWorldDir;
      varying vec2 vUv;
      void main() {
        float h = clamp(vWorldDir.y, 0.0, 1.0);
        // Pure deep-space black fading to near-black at horizon — no warm tint
        vec3 sky = mix(vec3(0.01, 0.01, 0.012), vec3(0.0), pow(h, 0.5));
        // Stars fill the whole dome, fade only right at the ground line
        vec3 stars = texture2D(uStarMap, vUv * vec2(2.0, 1.5)).rgb;
        float starBlend = smoothstep(0.0, 0.12, h);
        sky += stars * starBlend;
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat);
  scene.add(skyDome);

  // Dark neutral fog — terrain fades to black, no colour cast
  scene.fog = new THREE.FogExp2(0x080808, 0.006);

  // ── Textures ──
  const colorTex = loader.load('mars-texture.jpg');
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;

  const topoTex = loader.load('bg/mars_12k_topo.jpg');
  // Mirrored repeat eliminates the hard seam where the map's edges meet;
  // offset shifts the prime-meridian seam away from the centre of the terrain
  topoTex.wrapS = topoTex.wrapT = THREE.MirroredRepeatWrapping;
  topoTex.repeat.set(2, 1);
  topoTex.offset.set(0.18, 0);

  const normalTex = loader.load('bg/mars_12k_normal.jpg');
  normalTex.wrapS = normalTex.wrapT = THREE.MirroredRepeatWrapping;
  normalTex.repeat.set(6, 3);

  // ── Terrain ──
  const TERRAIN_W  = 800;
  const TERRAIN_D  = 500;
  const DISP_SCALE = 5.5;
  const DISP_BIAS  = -2.2;
  const CAM_Y      = 10.0;
  const LOOK_Y     = 10.5;

  const terrainMat = new THREE.MeshStandardMaterial({
    map:               colorTex,
    displacementMap:   topoTex,
    displacementScale: DISP_SCALE,
    displacementBias:  DISP_BIAS,
    normalMap:         normalTex,
    normalScale:       new THREE.Vector2(1.2, 1.2),
    roughness:         1.0,
    metalness:         0.0,
  });


  // Triplanar mapping: samples colour by world-space position instead of UV
  // Eliminates tiling seams and stretched texture on displaced crater walls
  terrainMat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vWorldPos;\n' + shader.vertexShader;
    // worldpos_vertex is conditionally compiled — compute world pos unconditionally instead
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );
    shader.fragmentShader = 'varying vec3 vWorldPos;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec3 triN = normalize(vNormal);
        vec3 triW = abs(triN);
        triW = max(triW - 0.2, 0.0);
        triW /= (triW.x + triW.y + triW.z + 0.001);
        const float TILE = 0.035;
        vec4 tx = texture2D(map, vWorldPos.zy * TILE);
        vec4 ty = texture2D(map, vWorldPos.xz * TILE);
        vec4 tz = texture2D(map, vWorldPos.xy * TILE);
        vec4 sampledDiffuseColor = tx * triW.x + ty * triW.y + tz * triW.z;
        #ifdef DECODE_VIDEO_TEXTURE
          sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
        #endif
        diffuseColor *= sampledDiffuseColor;
      #endif`
    );
  };

  const terrain = new THREE.Mesh(
    new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, 2048, 1024),
    terrainMat
  );
  terrain.rotation.x = -Math.PI / 2;
  scene.add(terrain);

  // ── Lighting ──
  const sun = new THREE.DirectionalLight(0xffc070, 3.2);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);

  // Warm fill from opposite side — softens harsh shadow crush
  const fill = new THREE.DirectionalLight(0xffaa66, 1.6);
  fill.position.set(-80, 20, -40);
  scene.add(fill);

  scene.add(new THREE.AmbientLight(0x6a4a2a, 5.5));

  // ── Navigation interception ──
  function isInternal(href) {
    if (!href) return false;
    if (href.startsWith('http') || href.startsWith('//')) return false;
    if (href.startsWith('mailto') || href.startsWith('tel')) return false;
    if (/\.(pdf|jpg|jpeg|png|mp4)$/i.test(href)) return false;
    if (href === '#' || href.startsWith('#')) return false;
    return true;
  }

  document.querySelectorAll('a').forEach(function (a) {
    const href = a.getAttribute('href');
    if (!isInternal(href)) return;
    a.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      try { sessionStorage.setItem('terrainFrom', JSON.stringify(PAGE)); } catch (_) {}
      window.location.href = href;
    });
  });

  // ── Fly-in state ──
  let fromPos = { x: PAGE.x, z: PAGE.z };
  let flyT    = 1;

  try {
    const stored = sessionStorage.getItem('terrainFrom');
    if (stored) {
      fromPos = JSON.parse(stored);
      flyT = 0;
      sessionStorage.removeItem('terrainFrom');
    }
  } catch (_) {}

  // ── Camera placement ──
  function setCameraAt(x, z, ldx, ldz) {
    camera.position.set(x, CAM_Y, z);
    const fx = ldx !== undefined ? ldx : 1;
    const fz = ldz !== undefined ? ldz : 0;
    camera.lookAt(x + fx * 30, LOOK_Y, z + fz * 30);
    skyDome.position.copy(camera.position);
  }

  setCameraAt(fromPos.x, fromPos.z);

  // ── SPA navigation hook — router dispatches this to move the camera ──
  let wasFlying = false;
  window.addEventListener('terrainnav', function (e) {
    fromPos   = { x: camera.position.x, z: camera.position.z };
    PAGE.x    = e.detail.x;
    PAGE.z    = e.detail.z;
    flyT      = 0;
    wasFlying = true;
  });

  // ── Easing ──
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // ── Render loop ──
  const FLY_DUR = 2.5;
  let lastTs = 0;
  // Look angle smoothed independently — interpolating angle (not raw X/Z) means
  // the camera always turns the short way and never passes through zero-length
  let lookAngle = 0;   // radians, matches initial ldx=1, ldz=0

  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    let cx, cz, targetAngle;

    if (flyT < 1) {
      flyT = Math.min(flyT + dt / FLY_DUR, 1);
      if (flyT >= 1 && wasFlying) {
        wasFlying = false;
        window.dispatchEvent(new CustomEvent('terrainlanded'));
      }
      const e  = easeInOutCubic(flyT);
      cx  = fromPos.x + (PAGE.x - fromPos.x) * e;
      cz  = fromPos.z + (PAGE.z - fromPos.z) * e;
      const dx  = PAGE.x - fromPos.x;
      const dz  = PAGE.z - fromPos.z;
      targetAngle = Math.atan2(dz, dx);
    } else {
      cx  = PAGE.x;
      cz  = PAGE.z;
      targetAngle = lookAngle;   // already there — hold
    }

    // Shortest-path angle interpolation — camera turns left or right, never
    // through zero-length which caused the upward-pan glitch on opposite routes
    let da = targetAngle - lookAngle;
    if (da >  Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    lookAngle += da * (1 - Math.exp(-3.5 * dt));

    setCameraAt(cx, cz, Math.cos(lookAngle), Math.sin(lookAngle));
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  // ── Resize ──
  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

})();
