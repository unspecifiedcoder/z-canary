import { actOnCaseStudy as act, createCaseStudy, downloadCaseStudy, CASE_DOSSIER, type CaseStudy } from './caseStudy';
import { sha256Hex } from '../crypto/shamir';

export type VaultChallenge = 'two-shares' | 'wrong-key' | 'stale-scan' | 'cancel';
export interface ChallengeResult {
  challenge: VaultChallenge;
  scenario: CaseStudy;
  title: string;
  explanation: string;
  receipt: string;
}

/** Every challenge uses a fresh public fixture and the existing cryptographic engine. */
export function runVaultChallenge(challenge: VaultChallenge): ChallengeResult {
  let scenario = act(createCaseStudy(), 'protect');
  scenario = act(scenario, 'check-in');
  if (challenge === 'cancel') {
    scenario = act(scenario, 'cancel');
    if (scenario.vault!.deliveredSharesToRecipient.length !== 0 || !scenario.vault!.keepers.every(k => k.lifecycleState === 'CANCELLED')) throw new Error('Cancellation invariant failed.');
    return { challenge, scenario, title: 'Cancellation held.', explanation: 'Maya signed a cancellation. We advanced beyond the original deadline. All five simulated keepers remained cancelled and delivered zero shares.', receipt: 'Signed CANCEL verified · old deadline passed · 0 shares delivered' };
  }
  scenario = act(scenario, 'miss-check-in');
  scenario = act(scenario, 'pause-scans');
  if (challenge === 'stale-scan') {
    if (scenario.vault!.deliveredSharesToRecipient.length !== 0 || !scenario.vault!.keepers.every(k => k.scannerHealth === 'DELAYED_SCAN')) throw new Error('Stale-scan invariant failed.');
    return { challenge, scenario, title: 'The keepers waited.', explanation: 'Time passed, but the keepers could not establish a fresh chain view. Their simulated release policy kept every share sealed.', receipt: 'Grace elapsed · 5 stale scans · 0 shares delivered' };
  }
  scenario = act(scenario, 'resume-two');
  if (challenge === 'two-shares') return { challenge, scenario, title: 'Two shares could not open it.', explanation: 'The real key reconstruction ran and rejected two valid shares. Noor needs a third distinct share to remove the release layer.', receipt: 'Reconstruction attempted · 2 valid shares · threshold 3 · rejected' };
  scenario = act(scenario, 'restore-third');
  scenario = act(scenario, 'try-wrong-key');
  return { challenge, scenario, title: 'The wrong recipient was rejected.', explanation: 'Three valid shares were available. A different recipient key still failed the real identity check. Only Noor’s matching key can open the inner layer.', receipt: 'Threshold reached · different recipient key tried · rejected' };
}

export function restoreChallengeThreshold(result: ChallengeResult): ChallengeResult {
  let scenario = result.scenario;
  if (scenario.step === 'scan-paused') scenario = act(scenario, 'resume-two');
  scenario = act(scenario, 'restore-third');
  return { ...result, scenario, title: 'Three shares. One recipient.', explanation: 'The third keeper delivered its valid share. Two keepers remain offline. Noor’s private key is still required to recover the file.', receipt: '3 distinct valid shares · 2 offline keepers · file still encrypted' };
}

export function recoverChallenge(result: ChallengeResult): ChallengeResult {
  const scenario = act(result.scenario, 'recover');
  const bytes = downloadCaseStudy(scenario);
  try {
    if (sha256Hex(bytes) !== sha256Hex(CASE_DOSSIER)) throw new Error('Exact-file recovery failed.');
    return { ...result, scenario, title: 'Noor recovered the exact file.', explanation: 'Three distinct shares and Noor’s matching private key decrypted Maya’s original notes. The recovered SHA-256 matches the source.', receipt: `Recovered ${bytes.length} bytes · source SHA-256 matched` };
  } finally { bytes.fill(0); }
}

export function rejectWrongChallengeRecipient(result: ChallengeResult): ChallengeResult {
  const scenario = act(result.scenario, 'try-wrong-key');
  return { ...result, scenario, title: 'The wrong recipient was rejected.', explanation: 'This same vault now has three valid shares. We tried a different recipient key and the identity check rejected it. Noor’s matching private key is still required.', receipt: 'Same vault · 3 valid shares · different recipient key rejected' };
}
