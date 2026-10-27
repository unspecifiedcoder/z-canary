import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ArrowUpRight, Layers3, Pause, Play } from 'lucide-react';
import { phaseLabels, type VaultVisualState } from '../experience/model';

const topics = [
  { name: 'Recipient seal', text: 'The inner layer is encrypted to the designated recipient. Keeper participation does not replace their private key.' },
  { name: 'Release layer', text: 'A separate random release key wraps the encrypted package. Three of five valid shares can reconstruct it.' },
  { name: 'Keeper stations', text: 'Each keeper evaluates confirmed commands and the grace boundary. This visualization represents browser records, not independent operators.' },
];

export default function LivingVault({ state, compact = false }: { state: VaultVisualState; compact?: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  const current = useRef(state);
  current.current = state;
  const [topic, setTopic] = useState(0);
  const [exploded, setExploded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [motionReduced, setMotionReduced] = useState(false);
  const [fallback, setFallback] = useState(false);
  const controls = useRef({ exploded, paused });
  controls.current = { exploded, paused };
  const renderOnce = useRef<() => void>(() => {});

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch { setFallback(true); return; }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    setMotionReduced(reduced.matches);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, host.clientWidth < 600 ? 1.25 : 1.7));
    renderer.setClearColor(0x0b1013, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, .1, 70);
    camera.position.set(5.6, 3.7, 8.9);
    camera.lookAt(0, .15, 0);
    const world = new THREE.Group(); scene.add(world);
    scene.add(new THREE.AmbientLight(0xa9c2c4, 2.4));
    const key = new THREE.DirectionalLight(0xf1ead8, 6); key.position.set(4, 7, 5); scene.add(key);
    const rim = new THREE.DirectionalLight(0x81e8df, 5); rim.position.set(-5, 1, -3); scene.add(rim);
    const under = new THREE.PointLight(0x4be6ce, 7, 10); under.position.set(0, -.9, 1); scene.add(under);

    const dark = new THREE.MeshStandardMaterial({ color: 0x222f34, roughness: .29, metalness: .82 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x536c70, roughness: .3, metalness: .76 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x97eee2, emissive: 0x3baea1, emissiveIntensity: .45, metalness: .25, roughness: .23, transparent: true, opacity: .65 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xa8f8e9 });
    const line = new THREE.LineBasicMaterial({ color: 0x50666b, transparent: true, opacity: .55 });
    const archive = new THREE.Group(); world.add(archive);
    const slabGeometry = new RoundedBoxGeometry(1.7, 2.1, .23, 3, .075);
    const front = new THREE.Mesh(slabGeometry, dark); front.position.z = .58; archive.add(front);
    const back = new THREE.Mesh(slabGeometry, dark); back.position.z = -.58; archive.add(back);
    const core = new THREE.Mesh(new RoundedBoxGeometry(1.38, 1.78, .58, 3, .06), glass); archive.add(core);
    const lock = new THREE.Mesh(new THREE.TorusGeometry(.2, .035, 8, 32, Math.PI), edge); lock.position.set(0, .15, .72); archive.add(lock);
    const lockBase = new THREE.Mesh(new RoundedBoxGeometry(.5, .37, .075, 2, .03), edge); lockBase.position.set(0, -.08, .72); archive.add(lockBase);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(.035, .13, .02), glow); slit.position.set(0, -.08, .77); archive.add(slit);
    const braces: THREE.Mesh[] = [];
    for (const x of [-.93, .93]) for (const y of [-.86, .86]) {
      const brace = new THREE.Mesh(new RoundedBoxGeometry(.1, .34, 1.5, 2, .035), edge);
      brace.position.set(x, y, 0); archive.add(brace); braces.push(brace);
    }
    for (let i = 0; i < 8; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(.8 - (i % 3) * .15, .018, .008), glow);
      strip.position.set(-.1, .6 - i * .14, .305); archive.add(strip);
    }
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.65, 3.65, .07, 80), new THREE.MeshStandardMaterial({ color: 0x101a1d, metalness: .55, roughness: .8 }));
    floor.position.y = -1.5; world.add(floor);
    for (const radius of [2.65, 3.15, 3.62]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, .008, 4, 96), edge);
      ring.rotation.x = Math.PI / 2; ring.position.y = -1.45; world.add(ring);
    }
    const keepers: {group: THREE.Group; light: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; path: THREE.Line; packet: THREE.Mesh}[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + .45;
      const x = Math.cos(angle) * 2.8, z = Math.sin(angle) * 2.8;
      const group = new THREE.Group(); group.position.set(x, -1.1, z);
      const pillar = new THREE.Mesh(new RoundedBoxGeometry(.38, .6, .38, 2, .05), dark); group.add(pillar);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(.075, 12, 8), new THREE.MeshBasicMaterial({ color: 0x92e2d6 })); cap.position.y = .36; group.add(cap);
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -.76, z), new THREE.Vector3(0, -.76, 0)]), line);
      world.add(path); world.add(group);
      const packet = new THREE.Mesh(new THREE.SphereGeometry(.04, 8, 6), glow); world.add(packet);
      keepers.push({ group, light: cap, path, packet });
    }
    let frame = 0, last = 0, visible = true, disposed = false, contextLost = false, motionTime = 0;
    const pointer = { x: 0, y: 0 };
    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.position.set(host.clientWidth < 500 ? 6.6 : 5.6, 3.7, host.clientWidth < 500 ? 11 : 8.9);
      camera.updateProjectionMatrix(); camera.lookAt(0, .1, 0); draw(performance.now(), true);
    };
    const draw = (time: number, force = false) => {
      if (disposed || contextLost) return;
      if (!force && (!visible || document.hidden || time - last < 32)) return;
      const dt = Math.max(0, Math.min((time - last) / 1000, .06)) || .03; last = time;
      const animate = !reduced.matches && !controls.current.paused;
      if (animate) motionTime += dt;
      const s = current.current;
      const color = s.phase === 'grace' ? 0xeab96b : s.phase === 'suspended' || s.phase === 'cancelled' ? 0x7c8a8b : 0x91e6d9;
      glow.color.setHex(color); glass.color.setHex(color);
      const open = s.decrypted ? 1.3 : controls.current.exploded ? 1 : s.phase === 'released' ? .48 : 0;
      const ease = reduced.matches || force ? 1 : .09;
      front.position.z += (.58 + open - front.position.z) * ease;
      back.position.z += (-.58 - open - back.position.z) * ease;
      braces.forEach(b => b.position.x += ((b.position.x < 0 ? -1 : 1) * (.93 + open * .4) - b.position.x) * ease);
      archive.position.y = animate ? Math.sin(motionTime * .65) * .045 : 0;
      world.rotation.y += ((animate ? pointer.x * .16 : 0) - world.rotation.y) * .07;
      world.rotation.x += ((animate ? pointer.y * .045 : 0) - world.rotation.x) * .07;
      keepers.forEach((k, i) => {
        const record = s.keepers[i];
        k.light.material.color.setHex(!record?.online ? 0x576366 : !record.healthy ? 0xeab96b : record.delivered ? 0xeafbf6 : color);
        k.packet.visible = !!record?.delivered && animate;
        const amount = (motionTime * .35 + i / 5) % 1;
        k.packet.position.set(k.group.position.x * (1 - amount), -.76 + Math.sin(amount * Math.PI) * .6, k.group.position.z * (1 - amount));
      });
      renderer.render(scene, camera);
    };
    const canAnimate = () => !disposed && !contextLost && visible && !document.hidden && !reduced.matches && !controls.current.paused;
    const tick = (time: number) => { frame = 0; draw(time); if (canAnimate()) frame = requestAnimationFrame(tick); };
    const wake = () => { if (frame) cancelAnimationFrame(frame); frame = 0; draw(performance.now(), !canAnimate()); if (canAnimate()) frame = requestAnimationFrame(tick); };
    const onPointer = (event: PointerEvent) => { const rect = host.getBoundingClientRect(); pointer.x = (event.clientX - rect.left) / rect.width * 2 - 1; pointer.y = (event.clientY - rect.top) / rect.height * 2 - 1; };
    const onLeave = () => { pointer.x = 0; pointer.y = 0; };
    const lost = (event: Event) => { event.preventDefault(); contextLost = true; visible = false; cancelAnimationFrame(frame); frame = 0; setFallback(true); };
    host.addEventListener('pointermove', onPointer); host.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const observer = new ResizeObserver(resize); observer.observe(host);
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; wake(); }); intersection.observe(host);
    const preferenceChanged = () => { setMotionReduced(reduced.matches); wake(); };
    document.addEventListener('visibilitychange', wake); reduced.addEventListener('change', preferenceChanged);
    renderOnce.current = wake;
    resize(); wake();
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); intersection.disconnect();
      document.removeEventListener('visibilitychange', wake); reduced.removeEventListener('change', preferenceChanged);
      host.removeEventListener('pointermove', onPointer); host.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m)); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      renderOnce.current = () => {};
    };
  }, []);
  useEffect(() => { renderOnce.current(); }, [state, exploded, paused]);

  return <section className={`living-vault ${compact ? 'living-vault--compact' : ''}`} aria-label="Interactive vault schematic">
    <div className="scene-topline"><span><i className={`signal-dot ${state.phase}`} />{state.decrypted ? 'Recovery verified' : phaseLabels[state.phase]}</span><span>CANARY / ARCHIVE 01</span></div>
    <div ref={mount} className="vault-canvas" />
    {fallback && <div className={`scene-fallback ${exploded ? 'is-expanded' : ''}`}><div className="fallback-layers"><div>Recipient seal</div><div>Release layer</div><div>Keeper threshold · {state.shares}/{state.threshold}</div></div><strong>{phaseLabels[state.phase]}</strong><span>2D schematic · 3D rendering unavailable</span></div>}
    <div className="scene-coordinate">{state.decrypted ? <>RECOVERY<br/>INTEGRITY VERIFIED</> : <>ENCRYPTED<br/>UNTIL PERMITTED</>}</div>
    <div className="scene-controls">
      <button onClick={() => setExploded(value => !value)} aria-pressed={exploded}><Layers3 size={14}/>{exploded ? 'Close layers' : 'Inspect layers'}</button>
      {!fallback && <button disabled={motionReduced} onClick={() => setPaused(value => !value)} aria-label={motionReduced ? 'Motion disabled by system preference' : paused ? 'Resume scene motion' : 'Pause scene motion'}>{paused ? <Play size={14}/> : <Pause size={14}/>}</button>}
    </div>
    <div className="scene-keeper-strip" aria-label="Keeper availability">{state.keepers.map(k => <span key={k.index} className={!k.online ? 'is-offline' : k.delivered ? 'is-delivered' : ''}><i/>{String(k.index).padStart(2, '0')}<span>{!k.online ? 'Offline' : k.delivered ? 'Delivered' : !k.healthy ? 'Paused' : 'Guarding'}</span></span>)}</div>
    {!compact && <div className="scene-explainer"><div className="scene-hotspots" role="group" aria-label="Explore vault mechanisms">{topics.map((item, i) => <button key={item.name} onClick={() => { setTopic(i); setExploded(i !== 2); }} aria-pressed={topic === i}><span>0{i + 1}</span>{item.name}<ArrowUpRight size={13}/></button>)}</div><p aria-live="polite">{topics[topic].text}</p></div>}
  </section>;
}
