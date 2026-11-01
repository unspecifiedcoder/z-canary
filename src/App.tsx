/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  Pickaxe,
  FastForward,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Menu,
  X,
} from 'lucide-react';
import { bytesToHex, sha256Hex } from './crypto/shamir';
import {
  encodeShieldedMemo,
  MemoOperation,
  ZcashNetwork,
} from './crypto/memoCodec';
import {
  ChainTransaction,
  ContinuityVault,
  createInitialPreloadedSetup,
  formatBlockHash,
  ScannerHealthState,
  ShieldedSupportTransaction,
  suspendVaultForReorg,
  synchronizeVaultWithChain,
} from './engine/protocolStore';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CreateVaultWizard } from './components/CreateVaultWizard';
import { VaultDetailConsole } from './components/VaultDetailConsole';
import { RecipientInboxScreen } from './components/RecipientInboxScreen';
import { SupportScreen } from './components/SupportScreen';
import { EvidenceAndKeepersPanel } from './components/EvidenceAndKeepersPanel';
import { JudgeJourney } from './components/JudgeJourney';
import { JudgeProof } from './components/JudgeProof';
import NativeVaultWorkspace from './components/NativeVaultWorkspace';
import { hashForTab, tabForDirectHash, tabForHash, type PublicAppTab } from './experience/routes';
import type { ExternalWalletSubmission } from './zcash/zip321';

const GuidedExperience = lazy(() => import('./components/GuidedExperience'));
const CaseStudyDemo = lazy(() => import('./components/CaseStudyDemo'));
const BreakVault = lazy(() => import('./components/BreakVault'));

type ActiveTab = PublicAppTab;

const INITIAL_HEIGHT = 2845100;

export default function App() {
  const [initialData] = useState(() => createInitialPreloadedSetup(INITIAL_HEIGHT));

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => tabForHash(window.location.hash));
  const mainRef = useRef<HTMLElement>(null);
  const didNavigate = useRef(false);
  useEffect(() => {
    if (tabForDirectHash(window.location.hash) !== activeTab) {
      window.history.replaceState(null, '', hashForTab(activeTab));
    }
    if (didNavigate.current) { mainRef.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    didNavigate.current = true;
  }, [activeTab]);
  useEffect(() => {
    const followHash = () => {
      const directTab = tabForDirectHash(window.location.hash);
      if (directTab) setActiveTab(directTab);
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number>(INITIAL_HEIGHT);
  const [forkSalt, setForkSalt] = useState<number>(0);
  const [recipientIdentity, setRecipientIdentity] = useState(initialData.recipientIdentity);
  const [vault, setVault] = useState<ContinuityVault>(initialData.vault);
  const [transactions, setTransactions] = useState<ChainTransaction[]>(initialData.transactions);
  const [walletBalanceZatoshi, setWalletBalanceZatoshi] = useState<number>(480000);
  const [selectedTxidForMemo, setSelectedTxidForMemo] = useState<string | null>(
    initialData.transactions[0]?.txid || null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [externalWalletSubmission, setExternalWalletSubmission] = useState<ExternalWalletSubmission | null>(null);

  const [supportHistory, setSupportHistory] = useState<ShieldedSupportTransaction[]>([
    {
      id: 'sup-1',
      txid: sha256Hex('orchard-support-note-initial-1'),
      amountZatoshi: 500000,
      blockHeight: INITIAL_HEIGHT - 12,
      confirmations: 13,
      timestamp: '2026-10-26 03:25:00 UTC',
      note: 'Confirmed Orchard Shielded Receipt (Unlinked)',
    },
  ]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4200);
  };

  /**
   * Advances the simulated Zcash Testnet block height and synchronizes all 5 isolated Keepers
   */
  const handleAdvanceBlocks = (
    deltaBlocks: number,
    overrideVault?: ContinuityVault,
    overrideTxs?: ChainTransaction[]
  ) => {
    const targetVault = overrideVault || vault;
    const targetTxs = overrideTxs || transactions;
    const nextHeight = currentBlockHeight + deltaBlocks;

    const updatedTxs = targetTxs.map((tx) => {
      if (tx.status === 'ORPHANED') return tx;
      if (tx.minedAtHeight === null) {
        return {
          ...tx,
          minedAtHeight: nextHeight,
          blockHash: formatBlockHash(nextHeight, forkSalt),
          confirmations: 1,
          status: 'MINED' as const,
        };
      }
      return {
        ...tx,
        confirmations: Math.max(1, nextHeight - tx.minedAtHeight + 1),
        status: nextHeight - tx.minedAtHeight + 1 >= targetVault.manifest.confirmationTarget ? 'CONFIRMED' as const : 'MINED' as const,
      };
    });

    const syncedVault = synchronizeVaultWithChain(targetVault, updatedTxs, nextHeight, forkSalt);
    setCurrentBlockHeight(nextHeight);
    setTransactions(updatedTxs);
    setVault(syncedVault);
  };

  /**
   * Signs a local 512-byte ZIP-302 Check-In / Postponement command (0x02)
   * and advances synthetic confirmations so browser keeper records process it in canonical order.
   */
  const handleCheckIn = (additionalBlocks: number) => {
    if (!Number.isInteger(additionalBlocks) || additionalBlocks < 1 || additionalBlocks > vault.manifest.maxExtensionBlocks) {
      showToast('Enter a whole number of blocks within the configured extension limit.');
      return;
    }
    if (!vault.keepers.some(k => k.lifecycleState === 'ACTIVE' || k.lifecycleState === 'GRACE') || currentBlockHeight + 1 > vault.graceDeadlineHeight) {
      showToast('This vault is not accepting check-ins. Confirm registration first, or create a new vault after expiry or cancellation.');
      return;
    }
    if (walletBalanceZatoshi < 10000) {
      showToast('Insufficient wallet balance (need 10,000 zatoshi). Visit Shielded Support.');
      return;
    }

    const nextSeq = vault.highestSequence + 1;
    const baseHeight = Math.max(currentBlockHeight, vault.currentExpiryHeight);
    const requestedExpiryHeight = baseHeight + additionalBlocks;
    if (requestedExpiryHeight > currentBlockHeight + 1 + vault.manifest.maxExtensionBlocks || requestedExpiryHeight > 0xffffffff) {
      showToast('The requested deadline exceeds the policy limit measured from the inclusion block. Choose a smaller extension.');
      return;
    }

    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.POSTPONE,
      switchIdHex: vault.manifest.switchIdHex,
      sequence: BigInt(nextSeq),
      requestedExpiryHeight,
      manifestDigestHex: vault.manifest.manifestDigestHex,
      sourcePubKeyHex: vault.sourcePubKeyHex,
    }, vault.sourceSecretHex);

    const memoHex = bytesToHex(memoBytes);
    const txid = sha256Hex(`tx-checkin-${vault.id}-seq-${nextSeq}-${Date.now()}`);
    const minedHeight = currentBlockHeight + 1;
    const confirmedHeight = minedHeight + vault.manifest.confirmationTarget - 1;

    const newTx: ChainTransaction = {
      txid,
      operationId: `op-postpone-${nextSeq}`,
      vaultId: vault.id,
      operation: MemoOperation.POSTPONE,
      sequence: nextSeq,
      requestedExpiryHeight,
      memoHex,
      feeZatoshi: 10000,
      submittedAtHeight: currentBlockHeight,
      minedAtHeight: minedHeight,
      blockHash: formatBlockHash(minedHeight, forkSalt),
      confirmations: vault.manifest.confirmationTarget,
      status: 'CONFIRMED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const nextTxs = [...transactions, newTx];
    const nextVaultPreSync: ContinuityVault = {
      ...vault,
      highestSequence: nextSeq,
      timeline: [
        ...vault.timeline,
        {
          id: `ev-checkin-${nextSeq}-${Date.now()}`,
          type: 'CHECKIN_CONFIRMED',
          title: `Simulated check-in included (Sequence #${nextSeq})`,
          detail: `Signed 512-byte POSTPONE memo reached ${vault.manifest.confirmationTarget} simulated confirmations. Offline or unhealthy keeper records must catch up before applying it. Requested expiry: #${requestedExpiryHeight}.`,
          blockHeight: confirmedHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    const syncedVault = synchronizeVaultWithChain(nextVaultPreSync, nextTxs, confirmedHeight, forkSalt);
    setWalletBalanceZatoshi((b) => b - 10000);
    setCurrentBlockHeight(confirmedHeight);
    setTransactions(nextTxs);
    setVault(syncedVault);
    setSelectedTxidForMemo(txid);
    showToast(
      `Simulated check-in confirmed. ${syncedVault.keepers.filter(k => k.lastSequence === BigInt(nextSeq)).length}/5 keeper records applied the new deadline.`
    );
  };

  /** Signs a local 512-byte CANCEL command (0x03) for the browser simulation. */
  const handleCancelVault = () => {
    if (!vault.keepers.some(k => k.lifecycleState === 'ACTIVE' || k.lifecycleState === 'GRACE')) {
      showToast('Cancellation is available only after registration and before release or cancellation.');
      return;
    }
    if (walletBalanceZatoshi < 10000 || currentBlockHeight + 1 > vault.graceDeadlineHeight) {
      showToast('Cancellation requires a funded wallet and inclusion before the grace boundary.');
      return;
    }
    const nextSeq = vault.highestSequence + 1;
    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.CANCEL,
      switchIdHex: vault.manifest.switchIdHex,
      sequence: BigInt(nextSeq),
      requestedExpiryHeight: 0,
      manifestDigestHex: vault.manifest.manifestDigestHex,
      sourcePubKeyHex: vault.sourcePubKeyHex,
    }, vault.sourceSecretHex);

    const memoHex = bytesToHex(memoBytes);
    const txid = sha256Hex(`tx-cancel-${vault.id}-seq-${nextSeq}-${Date.now()}`);
    const minedHeight = currentBlockHeight + 1;
    const confirmedHeight = minedHeight + vault.manifest.confirmationTarget - 1;

    const cancelTx: ChainTransaction = {
      txid,
      operationId: `op-cancel-${nextSeq}`,
      vaultId: vault.id,
      operation: MemoOperation.CANCEL,
      sequence: nextSeq,
      requestedExpiryHeight: 0,
      memoHex,
      feeZatoshi: 10000,
      submittedAtHeight: currentBlockHeight,
      minedAtHeight: minedHeight,
      blockHash: formatBlockHash(minedHeight, forkSalt),
      confirmations: vault.manifest.confirmationTarget,
      status: 'CONFIRMED',
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
    };

    const nextTxs = [...transactions, cancelTx];
    const nextVaultPreSync: ContinuityVault = {
      ...vault,
      highestSequence: nextSeq,
      timeline: [
        ...vault.timeline,
        {
          id: `ev-cancel-${Date.now()}`,
          type: 'CANCELLED',
          title: `Simulated cancel included (Sequence #${nextSeq})`,
          detail: 'Signed 512-byte CANCEL command reached simulated confirmation. Offline or unhealthy keeper records must catch up before applying it; delivered shares cannot be recalled.',
          blockHeight: confirmedHeight,
          txid,
          timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        },
      ],
    };

    const synced = synchronizeVaultWithChain(nextVaultPreSync, nextTxs, confirmedHeight, forkSalt);
    setWalletBalanceZatoshi((b) => Math.max(0, b - 10000));
    setCurrentBlockHeight(confirmedHeight);
    setTransactions(nextTxs);
    setVault(synced);
    setSelectedTxidForMemo(txid);
    showToast(`Simulated cancellation confirmed. ${synced.keepers.filter(k => k.lifecycleState === 'CANCELLED').length}/5 keeper records applied it; delivered shares cannot be recalled.`);
  };

  const handleJumpToGrace = () => {
    const targetHeight = vault.currentExpiryHeight + vault.manifest.confirmationTarget - 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('sentinel');
    showToast(
      `Advanced chain to #${currentBlockHeight + delta}. Keepers entered GRACE window (Expires at #${vault.graceDeadlineHeight}).`
    );
  };

  const handleJumpPastGraceToExpire = () => {
    const targetHeight = vault.graceDeadlineHeight + vault.manifest.confirmationTarget - 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('recipient');
    showToast(
      `Advanced chain past Grace (#${vault.graceDeadlineHeight}). Keepers authorized share delivery to Recipient Inbox.`
    );
  };

  const handleConfirmRegistration = () => {
    const delta = Math.max(1, vault.manifest.confirmationTarget - 1);
    handleAdvanceBlocks(delta);
    setActiveTab('sentinel');
    showToast('Simulated registration confirmed. All healthy keeper records are active; no transaction was sent.');
  };

  const handleReleaseBelowThreshold = () => {
    const available = Math.max(1, vault.manifest.threshold - 1);
    const targetHeight = vault.graceDeadlineHeight + vault.manifest.confirmationTarget - 1;
    const prepared = { ...vault, keepers: vault.keepers.map(keeper => ({
      ...keeper, online: keeper.index <= available, scannerHealth: 'HEALTHY' as const,
    })) };
    const nextHeight = Math.max(currentBlockHeight, targetHeight);
    const synced = synchronizeVaultWithChain(prepared, transactions, nextHeight, forkSalt);
    setCurrentBlockHeight(nextHeight);
    setVault(synced);
    setActiveTab('recipient');
    showToast(`Below-threshold test complete: ${synced.deliveredSharesToRecipient.length}/${vault.manifest.threshold} shares. Recovery must remain blocked.`);
  };

  const handleRestoreThreshold = () => {
    const required = vault.manifest.threshold;
    const prepared = { ...vault, keepers: vault.keepers.map(keeper => ({
      ...keeper, online: keeper.index <= required, scannerHealth: 'HEALTHY' as const,
    })) };
    const synced = synchronizeVaultWithChain(prepared, transactions, currentBlockHeight, forkSalt);
    setVault(synced);
    setActiveTab('recipient');
    showToast(`Threshold met: ${synced.deliveredSharesToRecipient.length}/${required} valid shares. The recipient key is still required.`);
  };

  const handleResetDemo = () => {
    const fresh = createInitialPreloadedSetup(INITIAL_HEIGHT);
    setCurrentBlockHeight(INITIAL_HEIGHT);
    setForkSalt(0);
    setVault(fresh.vault);
    setRecipientIdentity(fresh.recipientIdentity);
    setTransactions(fresh.transactions);
    setWalletBalanceZatoshi(480000);
    setSelectedTxidForMemo(fresh.transactions[0]?.txid || null);
    setExternalWalletSubmission(null);
    showToast('Reset deterministic harness to clean initial state (#2,845,100).');
  };

  const handleToggleKeeperOnline = (keeperIndex: number) => {
    const updatedKeepers = vault.keepers.map((k) =>
      k.index === keeperIndex
        ? {
            ...k,
            online: !k.online,
            logs: [
              ...k.logs,
              `[${currentBlockHeight}] Operator toggled process ${!k.online ? 'ONLINE' : 'OFFLINE'}.`,
            ],
          }
        : k
    );
    const synced = synchronizeVaultWithChain(
      { ...vault, keepers: updatedKeepers },
      transactions,
      currentBlockHeight,
      forkSalt
    );
    setVault(synced);
  };

  const handleSetKeeperScannerHealth = (keeperIndex: number, health: ScannerHealthState) => {
    if (vault.keepers.some(k => k.index === keeperIndex && k.scannerHealth === 'REORG_INCIDENT') && health !== 'REORG_INCIDENT') {
      showToast('Canonical replay is not implemented. Reset the synthetic scenario to clear a reorg incident.');
      return;
    }
    const updatedKeepers = vault.keepers.map((k) =>
      k.index === keeperIndex
        ? {
            ...k,
            scannerHealth: health,
            logs: [...k.logs, `[${currentBlockHeight}] Scanner health status changed to ${health}.`],
          }
        : k
    );
    setVault({ ...vault, keepers: updatedKeepers });
  };

  const handleSimulateReorg = (depth: 'shallow' | 'deep') => {
    const nextFork = forkSalt + 1;
    setForkSalt(nextFork);
    const rollbackHeight = depth === 'shallow' ? Math.max(0, currentBlockHeight - 2) : currentBlockHeight;
    setCurrentBlockHeight(rollbackHeight);
    setTransactions(transactions.map(tx => tx.minedAtHeight !== null && (depth === 'deep' || tx.minedAtHeight > rollbackHeight)
      ? {...tx, status: 'ORPHANED' as const, confirmations: 0} : tx));
    setVault(suspendVaultForReorg(vault, rollbackHeight));
    showToast('Reorg incident: processing suspended. Reset to continue; already delivered shares cannot be recalled.');
  };

  const navItems = [['welcome','Overview'],['break','Break the vault'],['case','Example'],['sentinel','Vault'],['recipient','Inbox'],['evidence','Keepers'],['judge','Judge Proof']] as const;
  const go = (tab: ActiveTab) => { setMenuOpen(false); setActiveTab(tab); };
  const modeLabel = activeTab==='native' ? 'Local workspace' : activeTab==='judge' ? 'Recorded testnet proof' : 'Browser lab';
  const modeText = activeTab==='native' ? 'Actual state is reported by your local agent. Testnet only.' : activeTab==='judge' ? 'Recorded transactions and archived signatures. This page does not report live keeper status.' : 'Real encryption in your browser. Simulated chain and keepers. No transactions sent.';

  return (
    <div className="canary-app">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className={`topbar ${menuOpen ? 'open' : ''}`}>
        <button className="brand" onClick={() => go('welcome')} aria-label="Canary overview"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.6 4.2c-2.4 0-4.2 1.7-4.6 4l-.2 1.1-5.5 2.3c-.8.3-.7 1.4.1 1.6l3.4.9c.6 2.8 3 4.9 6 4.9h.4l-1.6 2.6h2l1.5-2.7c2.3-1 3.9-3.3 3.9-5.9V7.2l1.8-1.4-2-.4c-.8-.8-1.9-1.2-3.2-1.2Zm.3 2.5a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z"/></svg></span><span className="brand-word">Canary</span></button>
        <nav className="nav" aria-label="Main navigation">
          {navItems.map(([tab,label]) => <button key={tab} onClick={() => go(tab)} aria-current={activeTab===tab ? 'page' : undefined}>{label}</button>)}
        </nav>
        <div className="topbar-actions">
          <button className="native-link" onClick={() => go('native')} aria-current={activeTab==='native' ? 'page' : undefined}><span className="dot ok" aria-hidden="true"/>Native testnet</button>
          <button className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={16}/> : <Menu size={16}/>}Menu</button>
        </div>
      </header>
      <div className="mode-note" role="note"><span className="pill"><span className="dot" aria-hidden="true"/>{modeLabel}</span><p>{modeText}</p>
        {activeTab!=='case' ? <button onClick={() => go('case')}>Follow Maya &amp; Noor&rsquo;s example</button> : <button onClick={() => go('demo')}>Protocol tour</button>}
      </div>
      {!['native','welcome','demo','case','judge','break'].includes(activeTab) && <details className="sim-tools">
        <summary><span>Simulation controls</span><code>Block #{currentBlockHeight.toLocaleString()} · {walletBalanceZatoshi.toLocaleString()} zat</code><span className="chip">Open</span></summary>
        <div><button onClick={() => handleAdvanceBlocks(1)}><Pickaxe size={14}/>Mine 1 block</button><button onClick={() => handleAdvanceBlocks(6)}>Mine 6 blocks</button><button onClick={handleJumpToGrace}>Enter grace</button><button onClick={handleJumpPastGraceToExpire}><FastForward size={14}/>Evaluate expiry</button><button onClick={handleResetDemo}><RotateCcw size={14}/>Reset</button><button onClick={() => go('create')}>New demo vault</button></div>
      </details>}

      {!['judge','break'].includes(activeTab) && <JudgeJourney
        vault={vault}
        isCustomVault={vault.id !== initialData.vault.id && ['create','sentinel','recipient','evidence'].includes(activeTab)}
        activePage={activeTab as 'create' | 'sentinel' | 'recipient' | 'evidence'}
        onNavigate={page => setActiveTab(page)}
        onConfirmRegistration={handleConfirmRegistration}
        onCheckIn={() => { handleCheckIn(vault.manifest.initialIntervalBlocks); setActiveTab('sentinel'); }}
        onEnterGrace={handleJumpToGrace}
        onReleaseBelowThreshold={handleReleaseBelowThreshold}
        onRestoreThreshold={handleRestoreThreshold}
        onReset={() => { handleResetDemo(); setActiveTab('create'); }}
      />}

      {toastMessage && <div role="status" aria-live="polite" className="toast"><span><CheckCircle2 size={16} style={{display:'inline',verticalAlign:'-3px',marginRight:8,color:'var(--yellow)'}}/>{toastMessage}</span><button onClick={() => setToastMessage(null)}>Dismiss</button></div>}

      <main id="main-content" ref={mainRef} tabIndex={-1} className={`main page-${activeTab}`}><div key={activeTab} className="page-reveal">
        {activeTab === 'welcome' && (
          <WelcomeScreen
            activeVault={vault}
            currentBlockHeight={currentBlockHeight}
            onNavigate={(tab) => setActiveTab(tab)}
            onToggleKeeperOnline={handleToggleKeeperOnline}
            onQuickDemoStep={(step) => {
              if (step === 'inspect') {
                setActiveTab('recipient');
              } else if (step === 'checkin') {
                setActiveTab('sentinel');
                handleCheckIn(vault.manifest.initialIntervalBlocks);
              } else if (step === 'support') {
                setActiveTab('support');
              } else if (step === 'grace') {
                handleJumpToGrace();
              } else if (step === 'expire') {
                handleJumpPastGraceToExpire();
              } else if (step === 'tests') {
                setActiveTab('evidence');
              }
            }}
          />
        )}

        {activeTab === 'create' && (
          <CreateVaultWizard
            recipientIdentity={recipientIdentity}
            currentBlockHeight={currentBlockHeight}
            walletBalanceZatoshi={walletBalanceZatoshi}
            onVaultCreated={(newVault, regTx, fee, newRecipient, externalSubmission) => {
              const nextTxs = [...transactions, regTx];
              setWalletBalanceZatoshi((b) => Math.max(0, b - fee));
              setTransactions(nextTxs);
              setVault(newVault);
              setRecipientIdentity(newRecipient);
              setSelectedTxidForMemo(regTx.txid);
              setExternalWalletSubmission(externalSubmission ?? null);
              setActiveTab('sentinel');
              showToast(
                externalSubmission
                  ? 'External wallet txid saved. Check its testnet explorer status; the lifecycle controls below remain a separate browser simulation.'
                  : 'Demo vault encrypted and local REGISTER simulation prepared. Advance simulated confirmation blocks to activate.'
              );
            }}
            onCancel={() => setActiveTab('sentinel')}
          />
        )}

        {activeTab === 'sentinel' && (
          <VaultDetailConsole
            vault={vault}
            currentBlockHeight={currentBlockHeight}
            walletBalanceZatoshi={walletBalanceZatoshi}
            transactions={transactions}
            onCheckIn={handleCheckIn}
            onCancelVault={handleCancelVault}
            onMineBlocks={(count) => handleAdvanceBlocks(count)}
            onInspectMemo={(txid) => {
              setSelectedTxidForMemo(txid);
              setActiveTab('evidence');
            }}
          />
        )}

        {activeTab === 'recipient' && (
          <RecipientInboxScreen
            vault={vault}
            recipientIdentity={recipientIdentity}
            currentBlockHeight={currentBlockHeight}
            onDecryptSuccess={(plaintext) => {
              setVault((prev) => ({
                ...prev,
                decryptedByRecipient: true,
                decryptedContentText: plaintext,
                timeline: [
                  ...prev.timeline,
                  {
                    id: `ev-dec-${Date.now()}`,
                    type: 'RECIPIENT_DECRYPTED',
                    title: 'Recipient reconstructed key and decrypted dossier',
                    detail: `${prev.manifest.threshold}-of-5 Keeper shares interpolated over GF(256) and inner X25519 envelope verified against SHA-256 digest.`,
                    blockHeight: currentBlockHeight,
                    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
                  },
                ],
              }));
              showToast('Dossier decrypted and SHA-256 digest verified!');
            }}
            onTriggerExpiryForDemo={handleJumpPastGraceToExpire}
          />
        )}

        {activeTab === 'support' && (
          <SupportScreen
            vault={vault}
            walletBalanceZatoshi={walletBalanceZatoshi}
            supportHistory={supportHistory}
            onReceiveSupportDonation={(amountZatoshi) => {
              const newReceipt: ShieldedSupportTransaction = {
                id: `sup-${Date.now()}`,
                txid: sha256Hex(`orchard-support-${Date.now()}`),
                amountZatoshi,
                blockHeight: currentBlockHeight,
                confirmations: 1,
                timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
                note: 'Confirmed Orchard Shielded Receipt (Zero Vault IDs)',
              };
              setSupportHistory((prev) => [newReceipt, ...prev]);
              setWalletBalanceZatoshi((b) => b + amountZatoshi);
              showToast(
                `Simulated receipt: +${amountZatoshi.toLocaleString()} zatoshi. No transaction was sent.`
              );
            }}
            onExecuteFundedCheckIn={() => {
              handleCheckIn(vault.manifest.initialIntervalBlocks);
              setActiveTab('sentinel');
            }}
          />
        )}

        {activeTab === 'evidence' && (
          <EvidenceAndKeepersPanel
            vault={vault}
            transactions={transactions}
            currentBlockHeight={currentBlockHeight}
            selectedTxidForMemo={selectedTxidForMemo}
            onToggleKeeperOnline={handleToggleKeeperOnline}
            onSetKeeperScannerHealth={handleSetKeeperScannerHealth}
            onSimulateReorg={handleSimulateReorg}
            onTriggerExpiryForDemo={handleJumpPastGraceToExpire}
          />
        )}

        {activeTab === 'native' && <NativeVaultWorkspace />}
        {activeTab === 'judge' && <JudgeProof />}
        {activeTab === 'break' && <Suspense fallback={<div className="scene-loading">Preparing the vault challenge…</div>}><BreakVault /></Suspense>}
        {activeTab === 'case' && <Suspense fallback={<div className="scene-loading">Preparing Maya and Noor's example…</div>}><CaseStudyDemo /></Suspense>}
        {activeTab === 'demo' && <Suspense fallback={<div className="scene-loading">Preparing the guided experience…</div>}><GuidedExperience onNative={() => setActiveTab('native')} /></Suspense>}
      </div></main>

      <footer className="footer card-dark">
        <div className="footer-top">
          <div><div className="footer-word">Canary<span>.</span></div><p>An encrypted safety handoff for reporters and sources. Private while you check in; recoverable by the one person you chose if you go silent.</p></div>
          <div className="footer-col"><h3>Try it</h3><button onClick={() => go('break')}>Break the vault</button><button onClick={() => go('case')}>Maya &amp; Noor example</button><button onClick={() => go('create')}>Protect your own file</button><button onClick={() => go('demo')}>Protocol tour</button></div>
          <div className="footer-col"><h3>Proof</h3><button onClick={() => go('judge')}>Judge Proof</button><button onClick={() => go('evidence')}>Keepers &amp; receipts</button><button onClick={() => go('native')}>Native testnet</button><button onClick={() => go('support')}>Support</button></div>
          <div className="footer-col"><h3>Source</h3><a href="https://github.com/unspecifiedcoder/z-canary" target="_blank" rel="noreferrer">GitHub</a><a href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/THREAT-MODEL.md" target="_blank" rel="noreferrer">Threat model</a><a href="https://github.com/unspecifiedcoder/z-canary/blob/main/docs/ARCHITECTURE.md" target="_blank" rel="noreferrer">Architecture</a></div>
        </div>
        {externalWalletSubmission && <a className="chip" style={{marginTop:24}} href={externalWalletSubmission.explorerUrl} target="_blank" rel="noreferrer">Latest external wallet tx · {externalWalletSubmission.txid.slice(0, 12)}… · Check explorer status ↗</a>}
        <details className="footer-bottom">
          <summary>Prototype boundaries &amp; trust model <span>Read the scope +</span></summary>
          <div className="boundaries">
            <p><strong>Hosted browser lab.</strong> File encryption, command signatures, threshold reconstruction, recipient-key decryption, and digest checks run for real in your browser. Its block clock, keeper records, and lifecycle confirmations are a resettable simulation.</p>
            <p><strong>External wallet handoff.</strong> Canary creates a ZIP-321 testnet request containing the locally verified signed REGISTER memo. A pasted txid opens the explorer; this static site does not independently query a lightwalletd service or mark it confirmed.</p>
            <p><strong>Native proof.</strong> The recorded native run used real Zcash testnet transactions and five keeper processes with durable state. Those demo processes share one operator and scanner endpoint; they are not five independent organizations.</p>
            <p><strong>Security status.</strong> Testnet prototype, not audited. The threshold assumes fewer than {vault.manifest.threshold} keepers collude; shares already delivered cannot be recalled by a later cancellation.</p>
          </div>
        </details>
        <div className="footer-legal"><span>Zcash testnet · {vault.manifest.threshold}-of-5 threshold · Signed shielded memos</span><span>Private by design. Deliberate by protocol.</span></div>
      </footer>
    </div>
  );
}
