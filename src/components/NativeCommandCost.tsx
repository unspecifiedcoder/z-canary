import React, { useState } from 'react';
import { nativeVaultApi, type NativeFeeEstimate } from '../services/nativeVault';

export default function NativeCommandCost({ baseUrl, token, enabled }: { baseUrl: string; token: string; enabled: boolean }) {
  const [quote, setQuote] = useState<NativeFeeEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const estimate = async () => {
    setBusy(true); setError(''); setQuote(null);
    try {
      const result = await nativeVaultApi.fees(baseUrl, token);
      if (result.network !== 'testnet' || ![result.feeZatoshi, result.noteAmountZatoshi, result.totalZatoshi, result.spendableZatoshi].every(value => Number.isSafeInteger(value) && value >= 0) || result.totalZatoshi !== result.feeZatoshi + result.noteAmountZatoshi) throw new Error('The agent returned an invalid cost estimate.');
      setQuote(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Cost estimation failed. Retry when the wallet is idle.'); }
    finally { setBusy(false); }
  };
  return <div className="native-command-cost"><button className="canary-button quiet" disabled={!enabled||busy} onClick={estimate}>{busy?'Calculating wallet proposal…':'Estimate command cost'} <span aria-hidden="true">↗</span></button>
    {quote&&<p>Proposal: <strong>{quote.feeZatoshi.toLocaleString()} zat fee</strong> + {quote.noteAmountZatoshi.toLocaleString()} zat note = <strong>{quote.totalZatoshi.toLocaleString()} zat</strong>. Spendable: {quote.spendableZatoshi.toLocaleString()} zat. Estimate only; the wallet recalculates before sending.</p>}
    {error&&<p role="alert" className="error-text">{error}</p>}
  </div>;
}
