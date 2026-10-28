import React from 'react';
import { ExternalLink } from 'lucide-react';
import { MemoOperation } from '../crypto/memoCodec';
import { TRANSPORT_RECEIPTS } from '../evidence/recordedRun';

const NAMES: Record<number, 'REGISTER' | 'POSTPONE' | 'CANCEL'> = {
  [MemoOperation.REGISTER]: 'REGISTER',
  [MemoOperation.POSTPONE]: 'POSTPONE',
  [MemoOperation.CANCEL]: 'CANCEL',
};

/** Ties a simulated lab command to the real, recorded Zcash testnet transaction of the same kind. */
export const RealCounterpart: React.FC<{ operation: MemoOperation | null }> = ({ operation }) => {
  if (operation === null) return null;
  const name = NAMES[operation];
  const receipt = TRANSPORT_RECEIPTS.find(r => r.operation === name);
  if (!receipt) return null;
  return (
    <p className="pt-1 text-xs leading-relaxed text-[#94A3B8]">
      Real counterpart: on Zcash testnet the same command, a signed 512-byte shielded memo ({name}), is transaction{' '}
      <a
        href={`https://testnet.cipherscan.app/tx/${receipt.txid}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-mono text-[#F59E0B] hover:underline"
      >
        {receipt.txid.slice(0, 10)}…{receipt.txid.slice(-6)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>{' '}
      at block {receipt.blockHeight.toLocaleString()}. This lab simulates the chain; that one is real.
    </p>
  );
};
