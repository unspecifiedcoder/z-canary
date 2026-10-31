import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { TRANSPORT_RECEIPTS } from '../evidence/recordedRun';
import { NATIVE_MEMO_RECEIPTS } from '../evidence/nativeMemos';
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
    <dt className="text-xs text-[var(--muted)]">{label}</dt>
    <dd className="break-all font-mono text-[11px] text-[var(--muted)]">{value}</dd>
  </div>
);

const VerificationLine: React.FC<{ result: ReceiptVerification }> = ({ result }) =>
  result.valid ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ok)]">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Signature valid
    </span>
  ) : (
    <span role="alert" className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--bad)]">
      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> {result.errorCode}: {result.errorMessage}
    </span>
  );

export const ReceiptVerifier: React.FC<{ labMemoHex?: string }> = ({ labMemoHex }) => {
  const verified = useMemo(
    () => [...NATIVE_MEMO_RECEIPTS, ...TRANSPORT_RECEIPTS].map(receipt => ({ receipt, result: verifyReceiptHex(receipt.memoHex) })),
    [],
  );
  const [pasted, setPasted] = useState(labMemoHex ?? '');
  useEffect(() => { if (labMemoHex) setPasted(labMemoHex); }, [labMemoHex]);
  const pastedResult = pasted.trim() ? verifyReceiptHex(pasted) : null;

  return (
    <section className="border border-[var(--line)] bg-[var(--sunken)]" aria-labelledby="receipt-verifier-title">
      <div className="border-b border-[var(--line)] px-4 py-4 space-y-1">
        <h2 id="receipt-verifier-title" className="text-sm font-semibold text-[var(--ink)]">Verify the receipts yourself</h2>
        <p className="max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
          All four commands from the protected-document run were recovered in a fresh viewing-only scan and matched
          byte for byte to the original signed journals. Your browser checks their 512-byte format and Ed25519 signatures
          here. Three earlier transport receipts follow them.
        </p>
      </div>

      <ol className="divide-y divide-[var(--line)]">
        {verified.map(({ receipt, result }) => (
          <li key={receipt.txid} className="px-4 py-3">
            <p className="mb-2 text-[11px] text-[var(--muted)]">{'label' in receipt ? NATIVE_LABELS[receipt.label] : 'Earlier transport run · public signing fixture'}</p>
            <details>
              <summary className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 md:grid-cols-[9rem_1fr_auto_auto]">
                <strong className="text-[13px] font-semibold text-[var(--ink)]">{result.operation ?? 'INVALID'}</strong>
                <span className="text-[11px] font-mono text-[var(--muted)]">
                  seq {result.sequence ?? '–'} · expiry {result.requestedExpiryHeight ? result.requestedExpiryHeight.toLocaleString() : 'none'} · block {receipt.blockHeight.toLocaleString()}
                </span>
                <VerificationLine result={result} />
                <a
                  href={explorerUrl(receipt.txid)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={event => event.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-[var(--accent-ink)] hover:underline"
                >
                  {shortHex(receipt.txid)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </summary>
              {result.valid && (
                <dl className="mt-3 grid gap-3 border-l-2 border-[var(--line)] pl-3 md:grid-cols-3">
                  <Detail label="Switch ID" value={result.switchIdHex!} />
                  <Detail label="Manifest digest" value={result.manifestDigestHex!} />
                  <Detail label="Signing public key" value={result.sourcePubKeyHex!} />
                  <div className="md:col-span-3"><Detail label="Original signed memo (512 bytes, hexadecimal)" value={receipt.memoHex} /></div>
                </dl>
              )}
            </details>
          </li>
        ))}
      </ol>
      <p className="border-t border-[var(--line)] px-4 py-3 text-[11px] leading-relaxed text-[var(--faint)]">
        The first four receipts cover the release and cancellation vaults. The last three share an earlier public signing
        fixture and demonstrate transport only. A valid signature proves authorship by its key, not a person's identity
        or transaction inclusion. The recorded scanner supplies the memo-to-transaction association.
        {' '}<a className="text-[var(--accent-ink)] underline" href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/evidence/native-live-memos.json" target="_blank" rel="noreferrer">Read the scan provenance and exact records</a>.
      </p>

      <div className="border-t border-[var(--line)] px-4 py-4 space-y-2">
        <label htmlFor="memo-paste" className="block text-xs font-medium text-[var(--ink)]">
          Paste any memo (1,024 hex characters) to check it
        </label>
        <textarea
          id="memo-paste"
          value={pasted}
          onChange={event => setPasted(event.target.value)}
          spellCheck={false}
          rows={3}
          placeholder="ff5a43414e01…"
          className="w-full rounded border border-[var(--line)] bg-[var(--sunken)] p-2 font-mono text-[11px] text-[var(--ink)]"
        />
        <div aria-live="polite" className="min-h-[1.25rem] text-xs">
          {pastedResult && <VerificationLine result={pastedResult} />}
          {pastedResult?.valid && labMemoHex && pasted === labMemoHex && (
            <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
              This is the memo from your browser lab run. Its signing key was generated in your browser and it was never sent to a chain, but it verifies with the same code that verified the real transactions above.
            </p>
          )}
          {pastedResult?.valid && (
            <span className="ml-3 font-mono text-[var(--muted)]">
              {pastedResult.operation} · seq {pastedResult.sequence} · switch {shortHex(pastedResult.switchIdHex!)}
            </span>
          )}
        </div>
      </div>

    </section>
  );
};
