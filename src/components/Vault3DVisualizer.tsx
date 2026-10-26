import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  Shield,
  RefreshCw,
  Layers,
  Eye,
  ChevronDown,
  ChevronUp,
  Power,
  FastForward,
} from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';

interface Vault3DVisualizerProps {
  vault: ContinuityVault;
  currentBlockHeight: number;
  onCheckIn: () => void;
  onToggleKeeperOnline: (keeperIndex: number) => void;
  onJumpToGrace: () => void;
  onTriggerExpiry: () => void;
}

type CameraPreset = 'ORBIT' | 'CORE_CLOSEUP' | 'TOP_MATRIX';

// Pre-allocated math helpers outside render loop (Zero GC)
const _targetCamPos = new THREE.Vector3();
const _targetLookAt = new THREE.Vector3(0, 0.2, 0);
const _currentLookAt = new THREE.Vector3(0, 0.2, 0);
const _colorActive = new THREE.Color(0x10b981);
const _colorGrace = new THREE.Color(0xf59e0b);
const _colorReleased = new THREE.Color(0x38bdf8);
const _colorOffline = new THREE.Color(0xef4444);
const _colorCancelled = new THREE.Color(0x64748b);

export const Vault3DVisualizer: React.FC<Vault3DVisualizerProps> = ({
  vault,
  currentBlockHeight,
  onCheckIn,
  onToggleKeeperOnline,
  onJumpToGrace,
  onTriggerExpiry,
}) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const vaultRef = useRef<ContinuityVault>(vault);
  vaultRef.current = vault;

  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('ORBIT');
  const cameraPresetRef = useRef<CameraPreset>('ORBIT');
  cameraPresetRef.current = cameraPreset;

  const [explodedAmount, setExplodedAmount] = useState<number>(0);
  const explodedRef = useRef<number>(0);
  explodedRef.current = explodedAmount;

  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const pulseTriggerRef = useRef<number>(0);

  const onlineKeepers = vault.keepers.filter((k) => k.online && k.scannerHealth === 'HEALTHY');
  const primaryState = onlineKeepers[0]?.lifecycleState || vault.keepers[0]?.lifecycleState || 'ACTIVE';
  const blocksLeft = Math.max(0, vault.currentExpiryHeight - currentBlockHeight);

  const handleTriggerHeartbeatWithPulse = () => {
    pulseTriggerRef.current = 1.0;
    onCheckIn();
  };

  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    // 1. Software-WebGL Detection from GPU renderer string
    const isSoftwareGl = (() => {
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const width = container.clientWidth || 960;
    const height = container.clientHeight || 460;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090b10);
    scene.fog = new THREE.FogExp2(0x090b10, 0.055);

    // 2. Mandatory Studio Environment Reflection (RoomEnvironment)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, 4.2, 8.8);
    camera.lookAt(0, 0.2, 0);

    // 3. Balanced 3-Point Studio Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0x94a3b8, 0x0f172a, 0.9);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfde68a, 2.2);
    keyLight.position.set(5, 8, 6);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.camera.left = -6;
      keyLight.shadow.camera.right = 6;
      keyLight.shadow.camera.top = 6;
      keyLight.shadow.camera.bottom = -6;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.4);
    rimLight.position.set(-6, 4, -5);
    scene.add(rimLight);

    // 4. Ground Pedestal & Contact Shadow Plane
    const floorGroup = new THREE.Group();
    scene.add(floorGroup);

    const baseDiscGeo = new THREE.CylinderGeometry(4.6, 4.8, 0.14, 64);
    const baseDiscMat = new THREE.MeshStandardMaterial({
      color: 0x11151f,
      roughness: 0.7,
      metalness: 0.3,
    });
    const baseDisc = new THREE.Mesh(baseDiscGeo, baseDiscMat);
    baseDisc.position.y = -1.45;
    baseDisc.receiveShadow = true;
    floorGroup.add(baseDisc);

    // Outer orbital track ring on pedestal
    const trackGeo = new THREE.RingGeometry(3.25, 3.33, 64);
    trackGeo.rotateX(-Math.PI / 2);
    const trackMat = new THREE.MeshBasicMaterial({
      color: 0x334155,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const trackRing = new THREE.Mesh(trackGeo, trackMat);
    trackRing.position.y = -1.36;
    floorGroup.add(trackRing);

    // Soft radial contact shadow canvas texture
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const sCtx = shadowCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 60);
      grad.addColorStop(0, 'rgba(0,0,0,0.65)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 128, 128);
    }
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    const contactShadowGeo = new THREE.PlaneGeometry(3.8, 3.8);
    contactShadowGeo.rotateX(-Math.PI / 2);
    const contactShadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
    });
    const contactShadow = new THREE.Mesh(contactShadowGeo, contactShadowMat);
    contactShadow.position.y = -1.35;
    floorGroup.add(contactShadow);

    // 5. Composite Multi-Part Central Continuity Vault (8 distinct parts)
    const centralVaultGroup = new THREE.Group();
    centralVaultGroup.position.set(0, 0.35, 0);
    scene.add(centralVaultGroup);

    // Part A: Inner Layer (Recipient X25519 Encrypted Dossier Core)
    const innerCoreGroup = new THREE.Group();
    centralVaultGroup.add(innerCoreGroup);

    const crystalGeo = new THREE.OctahedronGeometry(0.68, 1);
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: 0x10b981,
      emissive: 0x064e3b,
      emissiveIntensity: 0.45,
      roughness: 0.15,
      metalness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });
    const innerCrystal = new THREE.Mesh(crystalGeo, crystalMat);
    innerCoreGroup.add(innerCrystal);

    // Inner X25519 Seal Collar (Top & Bottom caps)
    const capGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.16, 6);
    const brushedGoldMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      roughness: 0.22,
      metalness: 0.92,
    });
    const topCap = new THREE.Mesh(capGeo, brushedGoldMat);
    topCap.position.y = 0.62;
    innerCoreGroup.add(topCap);

    const bottomCap = new THREE.Mesh(capGeo, brushedGoldMat);
    bottomCap.rotation.z = Math.PI;
    bottomCap.position.y = -0.62;
    innerCoreGroup.add(bottomCap);

    // Part B: Outer Layer (256-Bit Release Key Containment Gimbal Rings)
    const outerGimbal1Geo = new THREE.TorusGeometry(1.08, 0.065, 20, 64);
    const brushedTitaniumMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.35,
      metalness: 0.88,
    });
    const outerGimbal1 = new THREE.Mesh(outerGimbal1Geo, brushedTitaniumMat);
    centralVaultGroup.add(outerGimbal1);

    const outerGimbal2Geo = new THREE.TorusGeometry(1.26, 0.055, 20, 64);
    const darkArmorMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.55,
      metalness: 0.72,
    });
    const outerGimbal2 = new THREE.Mesh(outerGimbal2Geo, darkArmorMat);
    outerGimbal2.rotation.x = Math.PI / 2;
    centralVaultGroup.add(outerGimbal2);

    // Outer Split Shield Hemispheres (separate outward when exploded or released)
    const shieldHalfGeo = new THREE.CylinderGeometry(0.92, 0.92, 0.36, 8, 1, true);
    const shieldHalfMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
      metalness: 0.85,
      side: THREE.DoubleSide,
    });
    const upperShieldShell = new THREE.Mesh(shieldHalfGeo, shieldHalfMat);
    upperShieldShell.position.y = 0.28;
    centralVaultGroup.add(upperShieldShell);

    const lowerShieldShell = new THREE.Mesh(shieldHalfGeo, shieldHalfMat);
    lowerShieldShell.position.y = -0.28;
    centralVaultGroup.add(lowerShieldShell);

    // 6. Shielded Check-In Pulse Wave Ring
    const pulseWaveGeo = new THREE.RingGeometry(0.9, 1.12, 64);
    pulseWaveGeo.rotateX(-Math.PI / 2);
    const pulseWaveMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const pulseWaveMesh = new THREE.Mesh(pulseWaveGeo, pulseWaveMat);
    pulseWaveMesh.position.y = -0.8;
    scene.add(pulseWaveMesh);

    // 7. Five Isolated Keeper Sentinel Nodes (Composite 4-part Groups in Pentagon Orbit)
    interface KeeperVisualNode {
      group: THREE.Group;
      coreMesh: THREE.Mesh;
      haloMesh: THREE.Mesh;
      beamMesh: THREE.Mesh;
      coreMat: THREE.MeshStandardMaterial;
      haloMat: THREE.MeshBasicMaterial;
      beamMat: THREE.MeshBasicMaterial;
      baseAngle: number;
    }

    const keeperNodes: KeeperVisualNode[] = [];
    const orbitRadius = 3.3;

    const keeperChassisGeo = new THREE.CylinderGeometry(0.34, 0.4, 0.56, 6);
    const keeperChassisMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.48,
      metalness: 0.78,
    });
    const keeperCoreGeo = new THREE.OctahedronGeometry(0.22, 0);
    const keeperHaloGeo = new THREE.TorusGeometry(0.44, 0.025, 12, 32);
    keeperHaloGeo.rotateX(Math.PI / 2);

    // Tether beam connecting Keeper to Central Vault
    const beamGeo = new THREE.CylinderGeometry(0.018, 0.018, orbitRadius - 1.1, 8);
    beamGeo.rotateX(Math.PI / 2);

    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const kGroup = new THREE.Group();
      kGroup.position.set(
        Math.cos(angle) * orbitRadius,
        -0.65,
        Math.sin(angle) * orbitRadius
      );
      scene.add(kGroup);

      // Part 1: Hexagonal Armored Node Chassis
      const chassis = new THREE.Mesh(keeperChassisGeo, keeperChassisMat);
      chassis.castShadow = !isSoftwareGl;
      kGroup.add(chassis);

      // Part 2: Floating Cryptographic Share Core
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        emissive: 0x10b981,
        emissiveIntensity: 0.4,
        roughness: 0.2,
        metalness: 0.85,
      });
      const coreMesh = new THREE.Mesh(keeperCoreGeo, coreMat);
      coreMesh.position.y = 0.48;
      kGroup.add(coreMesh);

      // Part 3: Status Halo Ring
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
      });
      const haloMesh = new THREE.Mesh(keeperHaloGeo, haloMat);
      haloMesh.position.y = 0.48;
      kGroup.add(haloMesh);

      // Part 4: Tether Beam to Central Vault
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.35,
      });
      const beamMesh = new THREE.Mesh(beamGeo, beamMat);
      // Point beam toward center (0, 0.1, 0)
      beamMesh.position.set(
        -Math.cos(angle) * ((orbitRadius - 1.1) / 2),
        0.35,
        -Math.sin(angle) * ((orbitRadius - 1.1) / 2)
      );
      beamMesh.lookAt(0, 0.35, 0);
      kGroup.add(beamMesh);

      keeperNodes.push({
        group: kGroup,
        coreMesh,
        haloMesh,
        beamMesh,
        coreMat,
        haloMat,
        beamMat,
        baseAngle: angle,
      });
    }

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // 8. Animation Loop with Software-WebGL Fence Pacing
    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;
    let currentExplode = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.getElapsedTime();
      const v = vaultRef.current;

      // Camera Choreography with exponential damping
      const preset = cameraPresetRef.current;
      if (preset === 'ORBIT') {
        _targetCamPos.set(
          Math.sin(elapsed * 0.18) * 8.6,
          4.1,
          Math.cos(elapsed * 0.18) * 8.6
        );
        _targetLookAt.set(0, 0.1, 0);
      } else if (preset === 'CORE_CLOSEUP') {
        _targetCamPos.set(0, 1.4, 4.4);
        _targetLookAt.set(0, 0.35, 0);
      } else {
        _targetCamPos.set(0, 9.8, 0.01);
        _targetLookAt.set(0, -0.4, 0);
      }

      camera.position.x = THREE.MathUtils.damp(camera.position.x, _targetCamPos.x, 4, dt);
      camera.position.y = THREE.MathUtils.damp(camera.position.y, _targetCamPos.y, 4, dt);
      camera.position.z = THREE.MathUtils.damp(camera.position.z, _targetCamPos.z, 4, dt);
      _currentLookAt.lerp(_targetLookAt, 1 - Math.exp(-5 * dt));
      camera.lookAt(_currentLookAt);

      // Determine explosion separation: auto-open if RELEASED, or follow manual slider
      const isReleased = v.deliveredSharesToRecipient.length >= v.manifest.threshold;
      const targetExplode = isReleased ? Math.max(0.85, explodedRef.current) : explodedRef.current;
      currentExplode = THREE.MathUtils.damp(currentExplode, targetExplode, 5, dt);

      // Animate Central Dual-Layer Vault
      innerCrystal.rotation.y = elapsed * 0.55;
      innerCrystal.rotation.x = Math.sin(elapsed * 0.4) * 0.18;

      topCap.position.y = 0.62 + currentExplode * 0.55;
      bottomCap.position.y = -0.62 - currentExplode * 0.55;

      upperShieldShell.position.y = 0.28 + currentExplode * 0.95;
      lowerShieldShell.position.y = -0.28 - currentExplode * 0.95;
      upperShieldShell.rotation.y = -elapsed * 0.25;
      lowerShieldShell.rotation.y = elapsed * 0.25;

      outerGimbal1.rotation.y = elapsed * 0.45;
      outerGimbal1.rotation.x = Math.sin(elapsed * 0.5) * 0.5;
      outerGimbal1.scale.setScalar(1 + currentExplode * 0.25);

      outerGimbal2.rotation.z = elapsed * 0.38;
      outerGimbal2.rotation.y = Math.cos(elapsed * 0.4) * 0.5;
      outerGimbal2.scale.setScalar(1 + currentExplode * 0.35);

      // Check-in pulse wave animation
      if (pulseTriggerRef.current > 0) {
        pulseTriggerRef.current = Math.max(0, pulseTriggerRef.current - dt * 0.75);
        const progress = 1 - pulseTriggerRef.current;
        const scale = 1 + progress * 3.2;
        pulseWaveMesh.scale.set(scale, scale, 1);
        pulseWaveMat.opacity = pulseTriggerRef.current * 0.85;
      } else {
        pulseWaveMat.opacity = 0;
      }

      // Update each of the 5 Keeper Sentinel Nodes based on live state
      for (let i = 0; i < 5; i++) {
        const kState = v.keepers[i];
        const node = keeperNodes[i];
        if (!kState || !node) continue;

        const isOnline = kState.online && kState.scannerHealth === 'HEALTHY';
        const targetY = isOnline ? -0.58 : -0.92;
        node.group.position.y = THREE.MathUtils.damp(node.group.position.y, targetY, 6, dt);

        node.coreMesh.rotation.y = elapsed * (isOnline ? 1.1 : 0.15) + i;
        node.coreMesh.position.y = 0.48 + (isOnline ? Math.sin(elapsed * 2 + i) * 0.05 : -0.1);

        let targetColor = _colorActive;
        if (!kState.online || kState.scannerHealth !== 'HEALTHY') {
          targetColor = _colorOffline;
        } else if (kState.lifecycleState === 'GRACE') {
          targetColor = _colorGrace;
        } else if (kState.lifecycleState === 'RELEASED') {
          targetColor = _colorReleased;
        } else if (kState.lifecycleState === 'CANCELLED') {
          targetColor = _colorCancelled;
        }

        node.coreMat.color.lerp(targetColor, 1 - Math.exp(-6 * dt));
        node.coreMat.emissive.lerp(targetColor, 1 - Math.exp(-6 * dt));
        node.haloMat.color.lerp(targetColor, 1 - Math.exp(-6 * dt));
        node.beamMat.color.lerp(targetColor, 1 - Math.exp(-6 * dt));

        const targetBeamOpacity =
          !isOnline || kState.lifecycleState === 'CANCELLED'
            ? 0.04
            : kState.lifecycleState === 'RELEASED'
            ? 0.75
            : 0.35;
        node.beamMat.opacity = THREE.MathUtils.damp(
          node.beamMat.opacity,
          targetBeamOpacity,
          6,
          dt
        );
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    const handleResize = () => {
      if (!container || disposed) return;
      const w = container.clientWidth || 960;
      const h = container.clientHeight || 460;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-full h-[460px] lg:h-[520px] border border-[#222938] bg-[#090B10] overflow-hidden select-none">
      {/* Isolated WebGL Canvas Container */}
      <div ref={canvasMountRef} className="w-full h-full" />

      {/* Top-Left Minimal Spec & State Overlay (Unobstructed Center) */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none space-y-1.5 bg-[#0B0D11]/90 border border-[#222938] px-4 py-3 max-w-sm">
        <div className="text-[11px] font-mono text-[#F59E0B] tracking-wide">
          LIVE 3D CONTINUITY ARCHITECTURE
        </div>
        <div className="text-sm font-bold text-[#F8FAFC]">
          {primaryState === 'ACTIVE' && 'Vault Locked · 5 Keepers Guarding Shares'}
          {primaryState === 'GRACE' && 'Grace Period Active · Send Heartbeat Now'}
          {primaryState === 'RELEASED' && 'Threshold Reached (3/5) · Outer Cage Unlocked'}
          {primaryState === 'CANCELLED' && 'Switch Cancelled · Shares Zeroized'}
          {primaryState === 'REGISTERING' && 'Awaiting Block Confirmations'}
        </div>
        <div className="text-xs font-mono text-[#94A3B8] tabular-nums">
          Inner Emerald Core: Recipient X25519 · Outer Cage: {onlineKeepers.length}/5 Keepers Online
          {blocksLeft > 0 ? ` · ${blocksLeft} blocks until Grace` : ''}
        </div>
      </div>

      {/* Unified Collapsible Bottom Control Dock (Zero Side-Panel Clutter) */}
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[94%] max-w-[920px] transition-transform duration-200"
        style={{
          transform: dockCollapsed
            ? 'translate(-50%, calc(100% - 32px))'
            : 'translate(-50%, 0)',
        }}
      >
        {/* Collapse / Expand Toggle Handle */}
        <div className="flex justify-center">
          <button
            onClick={() => setDockCollapsed(!dockCollapsed)}
            className="px-3 py-1 bg-[#141820] border border-b-0 border-[#222938] text-[11px] font-mono text-[#94A3B8] hover:text-[#F8FAFC] flex items-center gap-1.5 cursor-pointer"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Show 3D Interactive Controls</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Hide Controls</span>
              </>
            )}
          </button>
        </div>

        {/* Main Bottom Dock Body */}
        <div className="bg-[#141820] border border-[#222938] px-4 py-3 flex flex-wrap items-center justify-between gap-4 text-xs">
          {/* Camera View Switcher */}
          <div className="flex items-center gap-1.5">
            <span className="text-[#64748B] font-mono mr-1">Camera:</span>
            {(
              [
                { id: 'ORBIT', label: 'Orbit View' },
                { id: 'CORE_CLOSEUP', label: 'Dual-Layer Core' },
                { id: 'TOP_MATRIX', label: '5-Keeper Ring' },
              ] as const
            ).map((cam) => (
              <button
                key={cam.id}
                onClick={() => setCameraPreset(cam.id)}
                className={`px-2.5 py-1 rounded font-mono transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  cameraPreset === cam.id
                    ? 'bg-[#F59E0B] text-[#0B0D11] font-semibold'
                    : 'bg-[#0B0D11] text-[#94A3B8] hover:text-[#F8FAFC] border border-[#222938]'
                }`}
              >
                {cam.label}
              </button>
            ))}
          </div>

          {/* Exploded Dual-Layer Slider */}
          <div className="flex items-center gap-2.5 font-mono">
            <span className="text-[#94A3B8] whitespace-nowrap">Inspect Layers:</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={explodedAmount}
              onChange={(e) => setExplodedAmount( parseFloat(e.target.value) )}
              className="w-24 accent-[#F59E0B] cursor-pointer"
            />
          </div>

          {/* Quick Interactive Node Toggles (1..5) */}
          <div className="flex items-center gap-1 font-mono">
            <span className="text-[#64748B] mr-1">Keepers:</span>
            {vault.keepers.map((k) => (
              <button
                key={k.index}
                onClick={() => onToggleKeeperOnline(k.index)}
                title={`Toggle Keeper 0${k.index} Online/Offline`}
                className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                  k.online
                    ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40'
                    : 'bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/40'
                }`}
              >
                K{k.index}
              </button>
            ))}
          </div>

          {/* Live Action Triggers */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleTriggerHeartbeatWithPulse}
              className="px-3 py-1.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] font-semibold rounded flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Send Heartbeat Pulse</span>
            </button>
            <button
              onClick={onTriggerExpiry}
              className="px-2.5 py-1.5 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-[#E2E8F0] font-mono rounded whitespace-nowrap shrink-0 cursor-pointer"
            >
              Simulate Release
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
