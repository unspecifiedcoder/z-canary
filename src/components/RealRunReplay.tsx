import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { NATIVE_RUN_CHECKS, NATIVE_RUN_TRANSACTIONS, NATIVE_RUN_VAULTS } from '../evidence/recordedRun';

interface ReplayStep {
  title: string;
  body: string;
  tx?: (typeof NATIVE_RUN_TRANSACTIONS)[number];
  outcome?: string;
  checks: string[];
}

const [releaseRegister, cancelRegister, cancelPostpone, cancelCancel] = NATIVE_RUN_TRANSACTIONS;

// Only facts recorded in docs/evidence/native-live-acceptance.json appear here.
const CHECK_LABELS: Record<string, string> = {
  release_five_verified_keeper_acknowledgements: 'five keepers acknowledged their shares',
  release_register_confirmed_on_testnet: 'REGISTER confirmed on testnet',
  cancel_five_verified_keeper_acknowledgements: 'five keepers acknowledged their shares',
  cancel_register_confirmed_on_testnet: 'REGISTER confirmed on testnet',
  cancel_postpone_confirmed_on_testnet: 'POSTPONE confirmed on testnet',
  cancel_cancel_confirmed_on_testnet: 'CANCEL confirmed on testnet',
  cancelled_vault_releases_no_shares: 'cancelled vault released no shares',
  subthreshold_recipient_recovery_rejected: 'recovery below the threshold was rejected',
  confirmed_expiration_releases_threshold_shares: 'expiry released the threshold shares',
  recipient_decryption_matches_original_sha256: 'decrypted file matches the original SHA-256',
  recipient_inbox_exposes_verified_release: 'recipient inbox showed the verified release',
};

const STEPS: readonly ReplayStep[] = [
  {
    title: 'Register the vault that will expire',
    body: 'The source signs a REGISTER command and sends it as a shielded memo. Five keepers acknowledge their provisioned shares.',
    tx: releaseRegister,
    checks: ['release_five_verified_keeper_acknowledgements', 'release_register_confirmed_on_testnet'],
  },
  {
    title: 'Register a second vault that will be cancelled',
    body: 'A second vault follows the same path, so the run can compare a release with a cancellation.',
    tx: cancelRegister,
    checks: ['cancel_five_verified_keeper_acknowledgements', 'cancel_register_confirmed_on_testnet'],
  },
  {
    title: 'The owner checks in on the second vault',
    body: 'A signed POSTPONE command moves its deadline. All five keeper databases applied it at sequence 1.',
    tx: cancelPostpone,
    checks: ['cancel_postpone_confirmed_on_testnet'],
  },
  {
    title: 'The owner cancels the second vault',
    body: 'A signed CANCEL command ends that vault’s release path.',
    tx: cancelCancel,
    outcome: `${NATIVE_RUN_VAULTS.cancel.lifecycle} · ${NATIVE_RUN_VAULTS.cancel.shareCount} shares delivered`,
    checks: ['cancel_cancel_confirmed_on_testnet', 'cancelled_vault_releases_no_shares'],
  },
  {
    title: 'The first vault passes its confirmed expiry',
    body: 'No valid check-in or cancellation arrived, so the keepers deliver their encrypted shares to the recipient.',
    outcome: `${NATIVE_RUN_VAULTS.release.lifecycle} · ${NATIVE_RUN_VAULTS.release.shareCount} shares delivered`,
    checks: ['subthreshold_recipient_recovery_rejected', 'confirmed_expiration_releases_threshold_shares'],
  },
  {
    title: 'The recipient decrypts the original file',
    body: 'The recipient’s own key plus the delivered shares recover the 136-byte public fixture, byte for byte.',
    outcome: `SHA-256 ${NATIVE_RUN_VAULTS.release.recoveredDigestHex}`,
    checks: ['recipient_decryption_matches_original_sha256', 'recipient_inbox_exposes_verified_release'],
  },
];

export const RealRunReplay: React.FC = () => {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const passedChecks = step.checks.filter(check => NATIVE_RUN_CHECKS.includes(check));

  return (
    <section className="border border-[#222938] bg-[#0B0D11]" aria-labelledby="replay-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#222938] px-4 py-4">
        <h2 id="replay-title" className="text-sm font-semibold text-[#F8FAFC]">Replay the real testnet run</h2>
        <span className="border border-[#F59E0B]/50 px-2 py-0.5 text-[10px] font-mono tracking-wider text-[#F59E0B]">
          RECORDED REAL RUN · NOT LIVE
        </span>
      </div>

      <div className="space-y-3 px-4 py-4" aria-live="polite">
        <div className="text-[11px] font-mono text-[#64748B]">STEP {index + 1} OF {STEPS.length}</div>
        <h3 className="text-base font-semibold text-[#F8FAFC]">{step.title}</h3>
        <p className="max-w-2xl text-xs leading-relaxed text-[#AEB8C8]">{step.body}</p>
        {step.tx && (
          <a
            href={`https://zexplorer.app/testnet/tx/${step.tx.txid}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 border border-[#2A3343] px-3 py-2 text-[11px] font-mono hover:border-[#F59E0B]/60"
          >
            <span className="text-[#64748B]">block {step.tx.blockHeight.toLocaleString()}</span>
            <span className="break-all text-[#F59E0B]">{step.tx.txid}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-[#F59E0B]" aria-hidden="true" />
          </a>
        )}
        {step.outcome && <p className="break-all font-mono text-xs text-[#10B981]">{step.outcome}</p>}
        {passedChecks.length > 0 && (
          <p className="text-[11px] leading-relaxed text-[#64748B]">
            Passed in the recorded run: {passedChecks.map(check => CHECK_LABELS[check] ?? check).join(' · ')}.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[#222938] px-4 py-3">
        <button
          type="button"
          onClick={() => setIndex(i => Math.max(0, i - 1))}
          disabled={index === 0}
          className="inline-flex items-center gap-1 border border-[#30394A] px-3 py-1.5 text-xs text-[#CBD5E1] disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Previous
        </button>
        <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={`h-1.5 w-5 ${i === index ? 'bg-[#F59E0B]' : i < index ? 'bg-[#10B981]/60' : 'bg-[#2A3343]'}`} />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setIndex(i => Math.min(STEPS.length - 1, i + 1))}
          disabled={index === STEPS.length - 1}
          className="inline-flex items-center gap-1 border border-[#F59E0B]/60 px-3 py-1.5 text-xs text-[#F59E0B] disabled:opacity-40"
        >
          Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="border-t border-[#1E2430] px-4 py-3 text-[11px] leading-relaxed text-[#64748B]">
        Five keeper processes ran on one machine, so this is not independent operators. Testnet TAZ has no value.
      </p>
    </section>
  );
};
