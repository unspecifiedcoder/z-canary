import type { ContinuityVault } from '../engine/protocolStore';

/** Public presentation projection. Never pass keys, shares or file bytes to WebGL. */
export interface VaultVisualState {
  phase: 'sealed' | 'grace' | 'released' | 'cancelled' | 'pending' | 'suspended';
  keepers: { index: number; online: boolean; healthy: boolean; delivered: boolean }[];
  shares: number;
  threshold: number;
  blocksRemaining: number;
  decrypted: boolean;
  sequence: number;
}

export function projectVault(vault: ContinuityVault, tip: number): VaultVisualState {
  const healthy = vault.keepers.filter(k => k.online && k.scannerHealth === 'HEALTHY');
  const states = new Set(healthy.map(k => k.lifecycleState));
  const phase = healthy.length === 0 || states.size !== 1 ? 'suspended'
    : states.has('CANCELLED') ? 'cancelled' : states.has('RELEASED') ? 'released'
    : states.has('GRACE') ? 'grace' : states.has('ACTIVE') ? 'sealed' : 'pending';
  return {
    phase, keepers: vault.keepers.map(k => ({ index: k.index, online: k.online,
      healthy: k.scannerHealth === 'HEALTHY', delivered: k.outboxDelivered })),
    shares: vault.deliveredSharesToRecipient.length, threshold: vault.manifest.threshold,
    blocksRemaining: Math.max(0, vault.currentExpiryHeight - Math.max(0, tip - vault.manifest.confirmationTarget + 1)),
    decrypted: vault.decryptedByRecipient, sequence: vault.highestSequence,
  };
}

export const phaseLabels: Record<VaultVisualState['phase'], string> = {
  sealed: 'Protected', grace: 'Grace window', released: 'Release authorized',
  cancelled: 'Cancelled', pending: 'Awaiting registration', suspended: 'Needs attention',
};

export const demoChapters = [
  { label: 'Protect', title: 'Some things must outlive your silence.', copy: 'A synthetic dossier is encrypted for one recipient, then sealed behind a second key. Five keeper records hold its shares.', action: 'Send a check-in' },
  { label: 'Check in', title: 'A small signal. More time.', copy: 'A signed POSTPONE command extends the deadline. The simulation verifies its signature before any keeper changes state.', action: 'Miss the next check-in' },
  { label: 'Overdue', title: 'Silence starts a grace window.', copy: 'Expiry alone does not unlock the file. A confirmed grace window leaves time for a valid check-in or cancellation.', action: 'Evaluate the boundary' },
  { label: 'Evaluate', title: 'No fresh scan. No release.', copy: 'Two keeper records are offline. The other three must scan through the complete grace boundary before delivering a share.', action: 'Collect permitted shares' },
  { label: 'Recover', title: 'Three shares. One recipient.', copy: 'Three valid, distinct shares meet the threshold. They recover the outer key; the designated recipient still needs their private key.', action: 'Verify and decrypt' },
  { label: 'Deliver', title: 'The right evidence. The right person.', copy: 'Authenticated decryption and the signed package digest are checked. This public synthetic fixture is now ready to download.', action: 'Run the story again' },
] as const;
