/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Pickaxe,
  FastForward,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
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
  synchronizeVaultWithChain,
} from './engine/protocolStore';
import { WelcomeScreen } from './components/WelcomeScreen';
import { CreateVaultWizard } from './components/CreateVaultWizard';
import { VaultDetailConsole } from './components/VaultDetailConsole';
import { RecipientInboxScreen } from './components/RecipientInboxScreen';
import { SupportScreen } from './components/SupportScreen';
import { EvidenceAndKeepersPanel } from './components/EvidenceAndKeepersPanel';

type ActiveTab = 'welcome' | 'sentinel' | 'create' | 'recipient' | 'support' | 'evidence';

const INITIAL_HEIGHT = 2845100;

export default function App() {
  const initialData = createInitialPreloadedSetup(INITIAL_HEIGHT);

  const [activeTab, setActiveTab] = useState<ActiveTab>('welcome');
  const [currentBlockHeight, setCurrentBlockHeight] = useState<number>(INITIAL_HEIGHT);
  const [forkSalt, setForkSalt] = useState<number>(0);
  const [recipientIdentity] = useState(initialData.recipientIdentity);
  const [vault, setVault] = useState<ContinuityVault>(initialData.vault);
  const [transactions, setTransactions] = useState<ChainTransaction[]>(initialData.transactions);
  const [walletBalanceZatoshi, setWalletBalanceZatoshi] = useState<number>(480000);
  const [selectedTxidForMemo, setSelectedTxidForMemo] = useState<string | null>(
    initialData.transactions[0]?.txid || null
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
      if (tx.minedAtHeight === null) {
        return {
          ...tx,
          minedAtHeight: nextHeight,
          blockHash: formatBlockHash(nextHeight, forkSalt),
          confirmations: 1,
          status: 'CONFIRMED' as const,
        };
      }
      return {
        ...tx,
        confirmations: Math.max(1, nextHeight - tx.minedAtHeight + 1),
      };
    });

    const syncedVault = synchronizeVaultWithChain(targetVault, updatedTxs, nextHeight, forkSalt);
    setCurrentBlockHeight(nextHeight);
    setTransactions(updatedTxs);
    setVault(syncedVault);
  };

  /**
   * Signs and broadcasts a 512-byte ZIP-302 Check-In / Postponement command (0x02)
   * and mines confirmation blocks so Keepers process it in canonical order.
   */
  const handleCheckIn = (additionalBlocks: number) => {
    if (walletBalanceZatoshi < 10000) {
      showToast('Insufficient wallet balance (need 10,000 zatoshi). Visit Shielded Support.');
      return;
    }

    const nextSeq = vault.highestSequence + 1;
    const baseHeight = Math.max(currentBlockHeight, vault.currentExpiryHeight);
    const requestedExpiryHeight = baseHeight + additionalBlocks;

    const memoBytes = encodeShieldedMemo({
      version: 1,
      network: ZcashNetwork.TESTNET,
      operation: MemoOperation.POSTPONE,
      switchIdHex: vault.manifest.switchIdHex,
      sequence: BigInt(nextSeq),
      requestedExpiryHeight,
      manifestDigestHex: vault.manifest.manifestDigestHex,
      sourcePubKeyHex: vault.sourcePubKeyHex,
    });

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
          title: `Check-in confirmed (Sequence #${nextSeq})`,
          detail: `Signed 512-byte ZIP-302 POSTPONE memo confirmed across online Keepers. Expiry extended to block #${requestedExpiryHeight}.`,
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
      `Check-In (Seq #${nextSeq}) confirmed at block #${confirmedHeight}. New deadline: #${requestedExpiryHeight}.`
    );
  };

  /**
   * Signs and broadcasts an irrevocable 512-byte CANCEL command (0x03)
   */
  const handleCancelVault = () => {
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
    });

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
          title: `Vault cancelled by Source (Sequence #${nextSeq})`,
          detail: 'Signed 512-byte CANCEL (0x03) command confirmed. All online Keepers transitioned to terminal CANCELLED state.',
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
    showToast('Cancellation confirmed. Switch is permanently deactivated.');
  };

  const handleJumpToGrace = () => {
    const targetHeight = vault.currentExpiryHeight + 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('sentinel');
    showToast(
      `Advanced chain to #${currentBlockHeight + delta}. Keepers entered GRACE window (Expires at #${vault.graceDeadlineHeight}).`
    );
  };

  const handleJumpPastGraceToExpire = () => {
    const targetHeight = vault.graceDeadlineHeight + 1;
    const delta = Math.max(1, targetHeight - currentBlockHeight);
    handleAdvanceBlocks(delta);
    setActiveTab('recipient');
    showToast(
      `Advanced chain past Grace (#${vault.graceDeadlineHeight}). Keepers authorized share delivery to Recipient Inbox.`
    );
  };

  const handleResetDemo = () => {
    const fresh = createInitialPreloadedSetup(INITIAL_HEIGHT);
    setCurrentBlockHeight(INITIAL_HEIGHT);
    setForkSalt(0);
    setVault(fresh.vault);
    setTransactions(fresh.transactions);
    setWalletBalanceZatoshi(480000);
    setSelectedTxidForMemo(fresh.transactions[0]?.txid || null);
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

    if (depth === 'shallow') {
      const rollbackHeight = Math.max(INITIAL_HEIGHT, currentBlockHeight - 2);
      const updatedKeepers = vault.keepers.map((k) => ({
        ...k,
        scanCursorHeight: rollbackHeight,
        scanCursorBlockHash: formatBlockHash(rollbackHeight, nextFork),
        logs: [
          ...k.logs,
          `[${rollbackHeight}] Shallow 2-block reorg detected. Rewound cursor to common ancestor #${rollbackHeight} and replayed canonical chain.`,
        ],
      }));
      setCurrentBlockHeight(rollbackHeight);
      setVault({
        ...vault,
        keepers: updatedKeepers,
        timeline: [
          ...vault.timeline,
          {
            id: `ev-reorg-${Date.now()}`,
            type: 'REORG_DETECTED',
            title: 'Shallow 2-block reorganization handled safely',
            detail: `Keepers rewound scan cursors to common ancestor #${rollbackHeight} and re-verified state.`,
            blockHeight: rollbackHeight,
            timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          },
        ],
      });
      showToast(`Simulated 2-block shallow reorg. Keepers replayed safely from #${rollbackHeight}.`);
    } else {
      const updatedKeepers = vault.keepers.map((k) => ({
        ...k,
        scannerHealth: 'REORG_INCIDENT' as const,
        logs: [
          ...k.logs,
          `[${currentBlockHeight}] ALERT: Deep reorganization crossed confirmation boundary! Suspended unreleased share dispatch.`,
        ],
      }));
      setVault({
        ...vault,
        keepers: updatedKeepers,
        timeline: [
          ...vault.timeline,
          {
            id: `ev-deep-reorg-${Date.now()}`,
            type: 'REORG_DETECTED',
            title: 'Deep reorganization incident raised — Release suspended',
            detail: 'Reorg crossed confirmation threshold. All 5 Keepers entered REORG_INCIDENT safety lock.',
            blockHeight: currentBlockHeight,
            timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          },
        ],
      });
      showToast('Deep reorg incident raised! All 5 Keepers suspended release dispatch.');
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D11] text-[#F1F5F9] flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-[#222938] bg-[#0B0D11]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#welcome"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('welcome');
          }}
          className="text-lg font-extrabold tracking-tight text-[#F8FAFC] whitespace-nowrap shrink-0 font-display"
        >
          Z-Canary
        </a>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#94A3B8]">
          <button
            onClick={() => setActiveTab('welcome')}
            className={`hover:text-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 ${
              activeTab === 'welcome' ? 'text-[#F8FAFC] border-b border-[#F59E0B]' : ''
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('sentinel')}
            className={`hover:text-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 ${
              activeTab === 'sentinel' ? 'text-[#F8FAFC] border-b border-[#F59E0B]' : ''
            }`}
          >
            Vault Sentinel
          </button>
          <button
            onClick={() => setActiveTab('recipient')}
            className={`hover:text-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 ${
              activeTab === 'recipient' ? 'text-[#F8FAFC] border-b border-[#F59E0B]' : ''
            }`}
          >
            Recipient Inbox
          </button>
          <button
            onClick={() => setActiveTab('support')}
            className={`hover:text-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 ${
              activeTab === 'support' ? 'text-[#F8FAFC] border-b border-[#F59E0B]' : ''
            }`}
          >
            Shielded Support
          </button>
          <button
            onClick={() => setActiveTab('evidence')}
            className={`hover:text-[#F8FAFC] transition-colors whitespace-nowrap shrink-0 cursor-pointer pb-0.5 ${
              activeTab === 'evidence' ? 'text-[#F8FAFC] border-b border-[#F59E0B]' : ''
            }`}
          >
            Evidence & Keepers
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setActiveTab('create')}
            className="px-4 py-2 text-xs font-semibold text-[#0B0D11] bg-[#F59E0B] hover:bg-[#D97706] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Continuity Vault
          </button>
        </div>
      </header>

      {/* Mobile Navigation Strip */}
      <div className="flex md:hidden items-center gap-4 overflow-x-auto px-6 py-2.5 border-b border-[#222938] bg-[#141820] text-xs font-medium text-[#94A3B8]">
        <button
          onClick={() => setActiveTab('welcome')}
          className={`whitespace-nowrap shrink-0 ${activeTab === 'welcome' ? 'text-[#F59E0B]' : ''}`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('sentinel')}
          className={`whitespace-nowrap shrink-0 ${activeTab === 'sentinel' ? 'text-[#F59E0B]' : ''}`}
        >
          Vault Sentinel
        </button>
        <button
          onClick={() => setActiveTab('recipient')}
          className={`whitespace-nowrap shrink-0 ${activeTab === 'recipient' ? 'text-[#F59E0B]' : ''}`}
        >
          Recipient Inbox
        </button>
        <button
          onClick={() => setActiveTab('support')}
          className={`whitespace-nowrap shrink-0 ${activeTab === 'support' ? 'text-[#F59E0B]' : ''}`}
        >
          Support
        </button>
        <button
          onClick={() => setActiveTab('evidence')}
          className={`whitespace-nowrap shrink-0 ${activeTab === 'evidence' ? 'text-[#F59E0B]' : ''}`}
        >
          Evidence & Keepers
        </button>
      </div>

      {/* Workspace Chain Simulation & Mining Bar (Unmistakably Labelled per Stop Rules) */}
      <div className="border-b border-[#222938] bg-[#141820]/90 px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-3 text-[#94A3B8] tabular-nums">
            <span className="text-[#F59E0B] font-semibold">
              SIMULATED TESTNET HARNESS
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Block: <strong className="text-[#F8FAFC]">#{currentBlockHeight.toLocaleString()}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Expiry: <strong className="text-[#E2E8F0]">#{vault.currentExpiryHeight.toLocaleString()}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Grace Boundary: <strong className="text-[#F59E0B]">#{vault.graceDeadlineHeight.toLocaleString()}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Wallet: <strong className="text-[#10B981]">{walletBalanceZatoshi.toLocaleString()} zat</strong>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => handleAdvanceBlocks(1)}
              className="px-2.5 py-1 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-[#E2E8F0] rounded flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Pickaxe className="w-3 h-3 text-[#F59E0B]" />
              <span>Mine +1 Block</span>
            </button>
            <button
              onClick={() => handleAdvanceBlocks(6)}
              className="px-2.5 py-1 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-[#E2E8F0] rounded whitespace-nowrap shrink-0 cursor-pointer"
            >
              Mine +6 Blocks
            </button>
            <button
              onClick={handleJumpToGrace}
              className="px-2.5 py-1 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-[#F59E0B] rounded whitespace-nowrap shrink-0 cursor-pointer"
            >
              Jump to Grace
            </button>
            <button
              onClick={handleJumpPastGraceToExpire}
              className="px-2.5 py-1 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#F59E0B]/40 text-[#FDE68A] rounded flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FastForward className="w-3 h-3" />
              <span>Trigger Expiry</span>
            </button>
            <button
              onClick={handleResetDemo}
              className="px-2.5 py-1 bg-[#0B0D11] hover:bg-[#1E2430] border border-[#222938] text-[#94A3B8] hover:text-[#F8FAFC] rounded flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset</span>
            </button>
          </div>
        </div>
      </div>

      {/* Toast Feedback Banner */}
      {toastMessage && (
        <div className="max-w-7xl w-full mx-auto px-6 pt-4">
          <div className="p-3.5 bg-[#141820] border border-[#F59E0B] text-xs font-mono text-[#F8FAFC] flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#F59E0B] shrink-0" />
              <span>{toastMessage}</span>
            </div>
            <button
              onClick={() => setToastMessage(null)}
              className="text-[#94A3B8] hover:text-[#F8FAFC] cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 pt-8">
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
            onVaultCreated={(newVault, regTx, fee) => {
              const nextTxs = [...transactions, regTx];
              setWalletBalanceZatoshi((b) => Math.max(0, b - fee));
              setTransactions(nextTxs);
              setVault(newVault);
              setSelectedTxidForMemo(regTx.txid);
              setActiveTab('sentinel');
              showToast(
                'New vault encrypted and 512B REGISTER memo broadcast. Mine confirmation blocks to activate.'
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
                    detail: `3-of-5 Keeper shares interpolated over GF(256) and inner X25519 envelope verified against SHA-256 digest.`,
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
                `Received +${amountZatoshi.toLocaleString()} zatoshi via unlinked Orchard note.`
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
      </main>

      {/* Quiet Editorial Footer */}
      <footer className="border-t border-[#222938] bg-[#0B0D11] px-6 py-5 mt-12">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#64748B] font-mono">
          <div>
            Z-Canary Continuity Protocol v1 · Zcash Testnet · 3-of-5 Keeper Threshold · ZIP-302 512B Memos
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setActiveTab('evidence')}
              className="hover:text-[#94A3B8] cursor-pointer"
            >
              Acceptance Suite
            </button>
            <span>·</span>
            <button
              onClick={() => setActiveTab('welcome')}
              className="hover:text-[#94A3B8] cursor-pointer"
            >
              Threat Model & Disclosures
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
