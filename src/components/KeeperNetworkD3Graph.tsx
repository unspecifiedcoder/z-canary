import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Send, FastForward } from 'lucide-react';
import { ContinuityVault, KeeperInstance } from '../engine/protocolStore';

interface KeeperNetworkD3GraphProps {
  vault: ContinuityVault;
  currentBlockHeight: number;
  onToggleKeeperOnline: (keeperIndex: number) => void;
  onTriggerExpiryForDemo?: () => void;
}

interface KeeperNodeDatum {
  id: string;
  index: number;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  keeper: KeeperInstance;
}

interface MeshLinkDatum {
  id: string;
  source: KeeperNodeDatum;
  target: KeeperNodeDatum;
  active: boolean;
}

interface HubLinkDatum {
  id: string;
  source: KeeperNodeDatum;
  targetX: number;
  targetY: number;
  online: boolean;
  transmitted: boolean;
}

export const KeeperNetworkD3Graph: React.FC<KeeperNetworkD3GraphProps> = ({
  vault,
  currentBlockHeight,
  onToggleKeeperOnline,
  onTriggerExpiryForDemo,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pulseCount, setPulseCount] = useState(0);
  const prevDeliveredCountRef = useRef<number>(vault.deliveredSharesToRecipient.length);

  const onlineHealthyKeepers = vault.keepers.filter(
    (k) => k.online && k.scannerHealth === 'HEALTHY'
  );
  const deliveredCount = vault.deliveredSharesToRecipient.length;
  const threshold = vault.manifest.threshold; // 3
  const isThresholdMet = deliveredCount >= threshold;
  const isQuorumReady = onlineHealthyKeepers.length >= threshold;

  // Automatically trigger share transmission animation when shares are newly delivered
  useEffect(() => {
    if (vault.deliveredSharesToRecipient.length > prevDeliveredCountRef.current) {
      setPulseCount((c) => c + 1);
    }
    prevDeliveredCountRef.current = vault.deliveredSharesToRecipient.length;
  }, [vault.deliveredSharesToRecipient.length]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const width = 860;
    const height = 400;
    const centerX = width / 2;
    const centerY = height / 2 + 6;
    const orbitRadius = 148;

    const svg = d3.select(svgEl);
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // Initialize SVG layer groups once so D3 transitions interpolate smoothly across state updates
    let defs = svg.select<SVGDefsElement>('defs');
    if (defs.empty()) {
      defs = svg.append('defs');

      // Subtle glow filter for transmitted share packets and threshold ring
      const filter = defs
        .append('filter')
        .attr('id', 'd3-share-glow')
        .attr('x', '-40%')
        .attr('y', '-40%')
        .attr('width', '180%')
        .attr('height', '180%');
      filter
        .append('feGaussianBlur')
        .attr('stdDeviation', '3.5')
        .attr('result', 'coloredBlur');
      const feMerge = filter.append('feMerge');
      feMerge.append('feMergeNode').attr('in', 'coloredBlur');
      feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

      svg.append('g').attr('class', 'layer-orbit-guides');
      svg.append('g').attr('class', 'layer-mesh-links');
      svg.append('g').attr('class', 'layer-hub-links');
      svg.append('g').attr('class', 'layer-packets');
      svg.append('g').attr('class', 'layer-center-hub');
      svg.append('g').attr('class', 'layer-keeper-nodes');
    }

    // Compute pentagonal node coordinates around central Threshold Reconstruction Hub
    const nodes: KeeperNodeDatum[] = vault.keepers.map((k, idx) => {
      const angle = (idx * 2 * Math.PI) / 5 - Math.PI / 2;
      // Widen horizontal spread for 16:9 canvas aspect ratio
      const x = centerX + Math.cos(angle) * (orbitRadius * 1.45);
      const y = centerY + Math.sin(angle) * (orbitRadius * 0.92);
      return {
        id: k.id,
        index: k.index,
        label: `KEEPER 0${k.index}`,
        sublabel: k.name.replace(/^Keeper 0\d\s*/, ''),
        x,
        y,
        keeper: k,
      };
    });

    // Build peer-to-peer mesh links between the 5 independent keepers
    const meshLinks: MeshLinkDatum[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const bothHealthy =
          a.keeper.online &&
          a.keeper.scannerHealth === 'HEALTHY' &&
          b.keeper.online &&
          b.keeper.scannerHealth === 'HEALTHY';
        meshLinks.push({
          id: `mesh-${a.id}-${b.id}`,
          source: a,
          target: b,
          active: bothHealthy,
        });
      }
    }

    // Build radial share transmission links from each Keeper to the Central Threshold Hub
    const hubLinks: HubLinkDatum[] = nodes.map((n) => ({
      id: `hub-${n.id}`,
      source: n,
      targetX: centerX,
      targetY: centerY,
      online: n.keeper.online && n.keeper.scannerHealth === 'HEALTHY',
      transmitted:
        n.keeper.outboxDelivered ||
        vault.deliveredSharesToRecipient.some((s) => s.index === n.index),
    }));

    const t = svg.transition().duration(600).ease(d3.easeCubicOut);

    // 1. Render background orbital ellipse guide
    const guidesLayer = svg.select<SVGGElement>('.layer-orbit-guides');
    const guideEllipse = guidesLayer.selectAll<SVGEllipseElement, number>('ellipse').data([1]);
    guideEllipse
      .join('ellipse')
      .attr('cx', centerX)
      .attr('cy', centerY)
      .attr('rx', orbitRadius * 1.45)
      .attr('ry', orbitRadius * 0.92)
      .attr('fill', 'none')
      .attr('stroke', '#1E2430')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,6');

    // 2. Render inter-keeper peer mesh links with smooth D3 transitions
    const meshLayer = svg.select<SVGGElement>('.layer-mesh-links');
    meshLayer
      .selectAll<SVGLineElement, MeshLinkDatum>('line.mesh-link')
      .data(meshLinks, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('class', 'mesh-link')
            .attr('x1', (d) => d.source.x)
            .attr('y1', (d) => d.source.y)
            .attr('x2', (d) => d.target.x)
            .attr('y2', (d) => d.target.y)
            .attr('stroke-opacity', 0),
        (update) => update,
        (exit) => exit.remove()
      )
      .transition(t as any)
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y)
      .attr('stroke', (d) => (d.active ? '#10B981' : '#EF4444'))
      .attr('stroke-width', (d) => (d.active ? 1.1 : 0.7))
      .attr('stroke-dasharray', (d) => (d.active ? 'none' : '3,5'))
      .attr('stroke-opacity', (d) => (d.active ? 0.22 : 0.12));

    // 3. Render radial Keeper-to-Threshold-Hub share channels
    const hubLayer = svg.select<SVGGElement>('.layer-hub-links');
    hubLayer
      .selectAll<SVGLineElement, HubLinkDatum>('line.hub-link')
      .data(hubLinks, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('class', 'hub-link')
            .attr('x1', (d) => d.source.x)
            .attr('y1', (d) => d.source.y)
            .attr('x2', (d) => d.targetX)
            .attr('y2', (d) => d.targetY),
        (update) => update,
        (exit) => exit.remove()
      )
      .transition(t as any)
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.targetX)
      .attr('y2', (d) => d.targetY)
      .attr('stroke', (d) =>
        !d.online ? '#EF4444' : d.transmitted ? '#38BDF8' : '#F59E0B'
      )
      .attr('stroke-width', (d) => (d.transmitted ? 2.6 : d.online ? 1.5 : 1))
      .attr('stroke-dasharray', (d) => (d.transmitted ? 'none' : d.online ? '5,5' : '2,6'))
      .attr('stroke-opacity', (d) => (d.transmitted ? 0.85 : d.online ? 0.45 : 0.2));

    // 4. Render Central 3-of-5 Threshold Reconstruction Hub with D3 Arc Gauge
    const centerLayer = svg.select<SVGGElement>('.layer-center-hub');
    const hubGroup = centerLayer
      .selectAll<SVGGElement, number>('g.hub-core')
      .data([1])
      .join((enter) => {
        const g = enter
          .append('g')
          .attr('class', 'hub-core')
          .attr('transform', `translate(${centerX}, ${centerY})`);
        g.append('circle').attr('class', 'hub-outer-bg').attr('r', 52);
        g.append('path').attr('class', 'hub-threshold-arc');
        g.append('circle').attr('class', 'hub-inner-disc').attr('r', 42);
        g.append('text')
          .attr('class', 'hub-title')
          .attr('text-anchor', 'middle')
          .attr('dy', '-8')
          .attr('font-family', 'JetBrains Mono, monospace')
          .attr('font-size', '10px')
          .attr('fill', '#94A3B8');
        g.append('text')
          .attr('class', 'hub-count')
          .attr('text-anchor', 'middle')
          .attr('dy', '10')
          .attr('font-family', 'JetBrains Mono, monospace')
          .attr('font-weight', '700')
          .attr('font-size', '14px');
        g.append('text')
          .attr('class', 'hub-sub')
          .attr('text-anchor', 'middle')
          .attr('dy', '25')
          .attr('font-family', 'JetBrains Mono, monospace')
          .attr('font-size', '9px');
        return g;
      });

    hubGroup.attr('transform', `translate(${centerX}, ${centerY})`);

    hubGroup
      .select('circle.hub-outer-bg')
      .transition(t as any)
      .attr('fill', '#0B0D11')
      .attr(
        'stroke',
        isThresholdMet ? '#38BDF8' : isQuorumReady ? '#10B981' : '#EF4444'
      )
      .attr('stroke-width', isThresholdMet ? 2.5 : 1.5)
      .attr('stroke-opacity', 0.5);

    // Smooth D3 arc representing either delivered shares (when releasing) or active quorum (3-of-5)
    const activeNumerator =
      deliveredCount > 0 ? Math.min(deliveredCount, 5) : onlineHealthyKeepers.length;
    const targetAngle = (activeNumerator / 5) * 2 * Math.PI;
    const arcGenerator = d3
      .arc<any>()
      .innerRadius(46)
      .outerRadius(52)
      .startAngle(0);

    hubGroup
      .select<SVGPathElement>('path.hub-threshold-arc')
      .datum({ endAngle: targetAngle })
      .transition(t as any)
      .attr(
        'fill',
        isThresholdMet ? '#38BDF8' : isQuorumReady ? '#10B981' : '#EF4444'
      )
      .attr('d', (d) => arcGenerator(d) || '');

    hubGroup
      .select('circle.hub-inner-disc')
      .transition(t as any)
      .attr('fill', isThresholdMet ? '#0C1928' : '#141820')
      .attr('stroke', '#222938')
      .attr('stroke-width', 1);

    hubGroup
      .select('text.hub-title')
      .text(deliveredCount > 0 ? 'SHARES TX' : 'QUORUM 3/5');

    hubGroup
      .select('text.hub-count')
      .transition(t as any)
      .attr(
        'fill',
        isThresholdMet ? '#38BDF8' : isQuorumReady ? '#10B981' : '#EF4444'
      )
      .text(
        deliveredCount > 0
          ? `${deliveredCount} / 3 MET`
          : `${onlineHealthyKeepers.length} / 5 LIVE`
      );

    hubGroup
      .select('text.hub-sub')
      .attr('fill', isThresholdMet ? '#38BDF8' : '#94A3B8')
      .text(
        isThresholdMet
          ? 'KEY UNLOCKED'
          : isQuorumReady
          ? 'THRESHOLD READY'
          : 'BELOW 3/5!'
      );

    // 5. Render the 5 Keeper Nodes with smooth D3 transitions and click-to-toggle interaction
    const nodesLayer = svg.select<SVGGElement>('.layer-keeper-nodes');
    const keeperGroups = nodesLayer
      .selectAll<SVGGElement, KeeperNodeDatum>('g.keeper-d3-node')
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter
          .append('g')
          .attr('class', 'keeper-d3-node')
          .style('cursor', 'pointer')
          .attr('transform', (d) => `translate(${d.x}, ${d.y})`);

        g.append('circle').attr('class', 'node-halo').attr('r', 32);
        g.append('circle').attr('class', 'node-core').attr('r', 24);
        g.append('text')
          .attr('class', 'node-id')
          .attr('text-anchor', 'middle')
          .attr('dy', '-3')
          .attr('font-family', 'JetBrains Mono, monospace')
          .attr('font-weight', '700')
          .attr('font-size', '10px');
        g.append('text')
          .attr('class', 'node-state')
          .attr('text-anchor', 'middle')
          .attr('dy', '10')
          .attr('font-family', 'JetBrains Mono, monospace')
          .attr('font-size', '8.5px');
        g.append('text')
          .attr('class', 'node-caption')
          .attr('text-anchor', 'middle')
          .attr('dy', '46')
          .attr('font-family', 'DM Sans, sans-serif')
          .attr('font-size', '11px')
          .attr('font-weight', '600');
        return g;
      });

    keeperGroups.on('click', (_event, d) => {
      onToggleKeeperOnline(d.index);
    });

    keeperGroups
      .transition(t as any)
      .attr('transform', (d) => `translate(${d.x}, ${d.y})`)
      .style('opacity', (d) => (d.keeper.online ? 1 : 0.55));

    keeperGroups
      .select('circle.node-halo')
      .transition(t as any)
      .attr('r', (d) => (d.keeper.online ? 31 : 26))
      .attr('fill', 'none')
      .attr('stroke', (d) => {
        if (!d.keeper.online || d.keeper.scannerHealth !== 'HEALTHY') return '#EF4444';
        if (d.keeper.outboxDelivered) return '#38BDF8';
        if (d.keeper.lifecycleState === 'GRACE') return '#F59E0B';
        return '#10B981';
      })
      .attr('stroke-width', (d) => (d.keeper.outboxDelivered ? 2.2 : 1.2))
      .attr('stroke-opacity', (d) => (d.keeper.online ? 0.65 : 0.3));

    keeperGroups
      .select('circle.node-core')
      .transition(t as any)
      .attr('fill', '#0B0D11')
      .attr('stroke', (d) => {
        if (!d.keeper.online || d.keeper.scannerHealth !== 'HEALTHY') return '#EF4444';
        if (d.keeper.outboxDelivered) return '#38BDF8';
        if (d.keeper.lifecycleState === 'GRACE') return '#F59E0B';
        return '#10B981';
      })
      .attr('stroke-width', 2);

    keeperGroups
      .select('text.node-id')
      .attr('fill', '#F8FAFC')
      .text((d) => `K-0${d.index}`);

    keeperGroups
      .select('text.node-state')
      .attr('fill', (d) => {
        if (!d.keeper.online) return '#EF4444';
        if (d.keeper.outboxDelivered) return '#38BDF8';
        if (d.keeper.lifecycleState === 'GRACE') return '#F59E0B';
        return '#10B981';
      })
      .text((d) =>
        !d.keeper.online
          ? 'OFFLINE'
          : d.keeper.outboxDelivered
          ? 'SENT'
          : d.keeper.lifecycleState
      );

    keeperGroups
      .select('text.node-caption')
      .attr('fill', '#CBD5E1')
      .text((d) => `${d.sublabel} (#${d.keeper.scanCursorHeight})`);

    // 6. Animate Share Transmission Packets along links when pulseCount increments
    if (pulseCount > 0) {
      const packetsLayer = svg.select<SVGGElement>('.layer-packets');
      const transmittingNodes = nodes.filter(
        (n) => n.keeper.online && n.keeper.scannerHealth === 'HEALTHY'
      );

      transmittingNodes.forEach((n, idx) => {
        const packet = packetsLayer
          .append('circle')
          .attr('cx', n.x)
          .attr('cy', n.y)
          .attr('r', 5.5)
          .attr('fill', isThresholdMet ? '#38BDF8' : '#F59E0B')
          .attr('filter', 'url(#d3-share-glow)')
          .attr('opacity', 1);

        packet
          .transition()
          .delay(idx * 90)
          .duration(850)
          .ease(d3.easeCubicInOut)
          .attr('cx', centerX)
          .attr('cy', centerY)
          .attr('r', 2.5)
          .on('end', function () {
            d3.select(this).remove();
          });
      });
    }
  }, [vault, currentBlockHeight, pulseCount, isThresholdMet, isQuorumReady]);

  return (
    <div className="border border-[#222938] bg-[#0B0D11] p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#1E2430] pb-4">
        <div className="space-y-1">
          <div className="text-xs font-mono text-[#F59E0B]">
            LIVE D3.JS TOPOLOGY · 3-OF-5 THRESHOLD CONSENSUS & SHARE TRANSMISSION
          </div>
          <h3 className="text-base font-bold text-[#F8FAFC]">
            Interactive Keeper Mesh & Threshold Share Transmission Graph
          </h3>
          <p className="text-xs text-[#94A3B8]">
            Click any Keeper node in the graph to toggle it online/offline, or transmit share
            packets to observe smooth D3 3-of-5 threshold transitions.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={() => setPulseCount((c) => c + 1)}
            className="px-3 py-1.5 bg-[#141820] hover:bg-[#1E2430] border border-[#222938] text-xs font-mono text-[#F8FAFC] rounded flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <Send className="w-3.5 h-3.5 text-[#38BDF8]" />
            <span>Transmit Share Pulse</span>
          </button>

          {!isThresholdMet && onTriggerExpiryForDemo && (
            <button
              onClick={() => {
                onTriggerExpiryForDemo();
                setPulseCount((c) => c + 1);
              }}
              className="px-3 py-1.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0B0D11] text-xs font-semibold rounded flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <FastForward className="w-3.5 h-3.5" />
              <span>Expire & Release 3-of-5 Shares</span>
            </button>
          )}
        </div>
      </div>

      {/* Responsive D3 SVG Canvas */}
      <div className="w-full overflow-x-auto">
        <svg
          ref={svgRef}
          className="w-full h-[360px] sm:h-[400px] block select-none"
          role="img"
          aria-label="D3.js 5-Keeper Network and 3-of-5 Threshold Share Transmission Topology"
        />
      </div>

      {/* Graph Legend */}
      <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-[#1E2430] text-[11px] font-mono text-[#94A3B8]">
        <div className="flex flex-wrap items-center gap-4">
          <span>· Emerald Ring: Online & Guarding Share</span>
          <span>· Amber Ring: In Grace Window</span>
          <span>· Cyan Solid Beam: Share Transmitted to Recipient</span>
          <span>· Crimson Dashed: Node Offline / Disconnected</span>
        </div>
        <div className="text-[#E2E8F0]">
          Threshold State: {isThresholdMet ? '3-of-5 Shares Reconstructed' : `${onlineHealthyKeepers.length}/5 Nodes Ready`}
        </div>
      </div>
    </div>
  );
};
