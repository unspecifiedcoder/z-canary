import React from 'react';
import { ArrowRight, Power } from 'lucide-react';
import { ContinuityVault } from '../engine/protocolStore';

interface KeeperNetworkD3GraphProps {
  vault: ContinuityVault;
  currentBlockHeight: number;
  onToggleKeeperOnline: (keeperIndex: number) => void;
  onTriggerExpiryForDemo?: () => void;
}

/** Public topology only: share bytes and private keys never enter SVG data. */
export const KeeperNetworkD3Graph: React.FC<KeeperNetworkD3GraphProps> = ({ vault, currentBlockHeight, onToggleKeeperOnline, onTriggerExpiryForDemo }) => {
  const nodes = vault.keepers.map((keeper, i) => {
    const angle = i * Math.PI * 2 / 5 - Math.PI / 2;
    return { index: keeper.index, online: keeper.online, healthy: keeper.scannerHealth === 'HEALTHY', delivered: keeper.outboxDelivered,
      x: 400 + Math.cos(angle) * 240, y: 194 + Math.sin(angle) * 145 };
  });
  const shares = vault.deliveredSharesToRecipient.length;
  return <div className="keeper-observatory">
    <div className="observatory-heading"><span className="section-label">RELEASE PATH / SIMULATED RECORDS</span><span>CONFIRMED CURSOR #{Math.max(0,currentBlockHeight-vault.manifest.confirmationTarget+1).toLocaleString()}</span></div>
    <svg viewBox="0 0 800 385" role="img" aria-label={`Five keeper records; ${shares} shares delivered, three required`}>
      <ellipse cx="400" cy="194" rx="240" ry="145" fill="none" stroke="#2d4438" strokeWidth="1" strokeDasharray="2 8"/>
      {nodes.map(node=><g key={node.index} opacity={node.online?1:.42}>
        <line x1={node.x} y1={node.y} x2="400" y2="194" stroke={node.delivered?'#a4e8d8':'#526e5c'} strokeWidth={node.delivered?1.5:1} strokeDasharray={node.delivered?'none':'3 7'}/>
        <rect x={node.x-32} y={node.y-25} width="64" height="50" fill="#101f17" stroke={node.delivered?'#a4e8d8':node.online?'#5b7e66':'#405448'}/>
        <text x={node.x} y={node.y+5} textAnchor="middle" fill={node.online?'#d5e8d9':'#8d9c91'} fontSize="15" fontFamily="monospace">0{node.index}</text>
        <text x={node.x} y={node.y+43} textAnchor="middle" fill="#9ab5a3" fontSize="9" fontFamily="monospace">{!node.online?'OFFLINE':node.delivered?'DELIVERED':!node.healthy?'SCAN PAUSED':'GUARDING'}</text>
      </g>)}
      <circle cx="400" cy="194" r="57" fill="#0c1911" stroke={shares>=3?'#a4e8d8':'#49664e'}/>
      <circle cx="400" cy="194" r="49" fill="none" stroke="#2d4934" strokeDasharray="1 6"/>
      <text x="400" y="195" textAnchor="middle" fill="#d5e8d9" fontSize="28" fontFamily="monospace">{shares}/3</text>
      <text x="400" y="215" textAnchor="middle" fill="#8fae99" fontSize="8" fontFamily="monospace">RECIPIENT</text>
    </svg>
    <div className="keeper-switches">{nodes.map(node=><button key={node.index} aria-pressed={node.online} onClick={()=>onToggleKeeperOnline(node.index)}><Power size={13}/><span>Station 0{node.index}</span><small>{node.online?'Online':'Offline'}</small></button>)}</div>
    <div className="observatory-caption"><p>Each station evaluates the same policy. Healthy scanning is required before a permitted share can reach the recipient.</p>{onTriggerExpiryForDemo&&<button className="text-link" onClick={onTriggerExpiryForDemo}>Evaluate simulated expiry <ArrowRight size={14}/></button>}</div>
  </div>;
};
