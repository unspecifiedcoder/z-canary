import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { NATIVE_RUN_TRANSACTIONS, TRANSPORT_RECEIPTS } from '../evidence/recordedRun';
import { ReceiptVerification, verifyReceiptHex } from '../evidence/verifyReceipt';

const explorerUrl = (txid: string) => `https://testnet.cipherscan.app/tx/${txid}`;
const shortHex = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-8)}`;

const NATIVE_LABELS: Record<string, string> = {
  release_register: 'REGISTER · vault that expires',
  cancel_register: 'REGISTER · vault that is cancelled',
  cancel_postpone: 'POSTPONE · check-in on the cancelled vault',
  cancel_cancel: 'CANCEL · the cancelled vault',
};

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-[10px] font-mono tracking-wider text-[#64748B]">{label}</dt>
    <dd className="break-all font-mono text-[11px] text-[#AEB8C8]">{value}</dd>
  </div>
);

const VerificationLine: React.FC<{ result: ReceiptVerification }> = ({ result }) =>
  result.valid ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#10B981]">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Signature valid
    </span>
  ) : (
    <span role="alert" className="inline-flex items-center gap-1.5 text-xs font-medium text-red-300">
      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> {result.errorCode}: {result.errorMessage}
    </span>
  );

export const ReceiptVerifier: React.FC<{ labMemoHex?: string }> = ({ labMemoHex }) => {
  const verified = useMemo(
    () => TRANSPORT_RECEIPTS.map(receipt => ({ receipt, result: verifyReceiptHex(receipt.memoHex) })),
    [],
  );
  const [pasted, setPasted] = useState(labMemoHex ?? '');
  useEffect(() => { if (labMemoHex) setPasted(labMemoHex); }, [labMemoHex]);
  const pastedResult = pasted.trim() ? verifyReceiptHex(pasted) : null;

  return (
    <section className="border border-[#222938] bg-[#0B0D11]" aria-labelledby="receipt-verifier-title">
      <div className="border-b border-[#222938] px-4 py-4 space-y-1">
        <h2 id="receipt-verifier-title" className="text-sm font-semibold text-[#F8FAFC]">Verify the receipts yourself</h2>
        <p className="max-w-3xl text-xs leading-relaxed text-[#94A3B8]">
          Shielded memos are encrypted, so Zcash Explorer shows only that a transaction exists at a block. These three
          recorded memos were recovered by a viewing-only scanner. Your browser re-runs the same strict 512-byte format and
          Ed25519 checks the keepers apply, so you do not have to take our word for what each transaction said.
        </p>
      </div>

      <ol className="divide-y divide-[#1E2430]">
        {verified.map(({ receipt, result }) => (
          <li key={receipt.txid} className="px-4 py-3">
            <details>
              <summary className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 md:grid-cols-[9rem_1fr_auto_auto]">
                <strong className="text-xs font-mono text-[#F8FAFC]">{result.operation ?? 'INVALID'}</strong>
                <span className="text-[11px] font-mono text-[#94A3B8]">
                  seq {result.sequence ?? '–'} · expiry {result.requestedExpiryHeight ? result.requestedExpiryHeight.toLocaleString() : 'none'} · block {receipt.blockHeight.toLocaleString()}
                </span>
                <VerificationLine result={result} />
                <a
                  href={explorerUrl(receipt.txid)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={event => event.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-[#F59E0B] hover:underline"
                >
                  {shortHex(receipt.txid)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </summary>
              {result.valid && (
                <dl className="mt-3 grid gap-3 border-l-2 border-[#2A3343] pl-3 md:grid-cols-3">
                  <Detail label="SWITCH ID" value={result.switchIdHex!} />
                  <Detail label="MANIFEST DIGEST" value={result.manifestDigestHex!} />
                  <Detail label="SIGNING KEY (PUBLIC TEST FIXTURE)" value={result.sourcePubKeyHex!} />
                </dl>
              )}
            </details>
          </li>
        ))}
      </ol>
      <p className="border-t border-[#1E2430] px-4 py-3 text-[11px] leading-relaxed text-[#64748B]">
        All three share one switch ID, manifest digest and signing key. This earlier transport run used a public signing
        fixture, so it demonstrates the transport and the verifier, not a protected document. The signature proves the
        command was authored by that key; it does not make the key a real person’s identity.
      </p>

      <div className="border-t border-[#222938] px-4 py-4 space-y-2">
        <label htmlFor="memo-paste" className="block text-xs font-medium text-[#E2E8F0]">
          Paste any memo (1,024 hex characters) to check it
        </label>
        <textarea
          id="memo-paste"
          value={pasted}
          onChange={event => setPasted(event.target.value)}
          spellCheck={false}
          rows={3}
          placeholder="ff5a43414e01…"
          className="w-full rounded border border-[#2E3748] bg-[#05070A] p-2 font-mono text-[11px] text-[#F8FAFC]"
        />
        <div aria-live="polite" className="min-h-[1.25rem] text-xs">
          {pastedResult && <VerificationLine result={pastedResult} />}
          {pastedResult?.valid && labMemoHex && pasted === labMemoHex && (
            <p className="mt-2 text-xs leading-relaxed text-[#94A3B8]">
              This is the memo from your browser lab run. Its signing key was generated in your browser and it was never sent to a chain, but it verifies with the same code that verified the real transactions above.
            </p>
          )}
          {pastedResult?.valid && (
            <span className="ml-3 font-mono text-[#94A3B8]">
              {pastedResult.operation} · seq {pastedResult.sequence} · switch {shortHex(pastedResult.switchIdHex!)}
            </span>
          )}
        </div>
      </div>

      <div className="border-t border-[#222938]">
        <p className="px-4 pt-3 text-[11px] leading-relaxed text-[#64748B]">
          The four commands from the protected-document run are confirmed on testnet, but their memo bytes were not archived
          in this release, so they link to the explorer only.
        </p>
        <ul className="divide-y divide-[#1E2430]">
          {NATIVE_RUN_TRANSACTIONS.map(tx => (
            <li key={tx.txid}>
              <a
                href={explorerUrl(tx.txid)}
                target="_blank"
                rel="noreferrer"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-[#141820] md:grid-cols-[1fr_auto_auto]"
              >
                <span className="text-xs text-[#E2E8F0]">{NATIVE_LABELS[tx.label] ?? tx.label}</span>
                <span className="hidden text-[11px] font-mono text-[#64748B] md:block">block {tx.blockHeight.toLocaleString()}</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#F59E0B]">
                  {shortHex(tx.txid)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
