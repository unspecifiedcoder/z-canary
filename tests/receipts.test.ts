import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TRANSPORT_RECEIPTS, NATIVE_RUN_TRANSACTIONS, NATIVE_RUN_CHECKS } from '../src/evidence/recordedRun';
import { NATIVE_MEMO_RECEIPTS } from '../src/evidence/nativeMemos';
import { verifyReceiptHex } from '../src/evidence/verifyReceipt';

const transport = JSON.parse(readFileSync('docs/evidence/testnet-transport.json', 'utf8'));
const acceptance = JSON.parse(readFileSync('docs/evidence/native-live-acceptance.json', 'utf8'));
const nativeArchive = JSON.parse(readFileSync('docs/evidence/native-live-memos.json', 'utf8'));

test('all four native memos verify with exact acceptance context and lifecycle sequence', () => {
  assert.deepEqual(NATIVE_MEMO_RECEIPTS, nativeArchive.records);
  const expected = [['REGISTER', '0', 4546658], ['REGISTER', '0', 4546757], ['POSTPONE', '1', 4546761], ['CANCEL', '2', 0]];
  NATIVE_MEMO_RECEIPTS.forEach((receipt, index) => {
    assert.equal(receipt.memoHex.length, 1024);
    const result = verifyReceiptHex(receipt.memoHex);
    assert.equal(result.valid, true, result.errorMessage);
    assert.deepEqual([result.operation, result.sequence, result.requestedExpiryHeight], expected[index]);
    assert.equal(result.switchIdHex, acceptance.vaults[index === 0 ? 0 : 1].switchId);
    assert.equal(result.switchIdHex, receipt.switchIdHex);
    assert.equal(result.manifestDigestHex, receipt.manifestDigestHex);
    assert.equal(result.sourcePubKeyHex, receipt.sourcePubKeyHex);
    assert.equal(receipt.sourcePubKeyHex, '44f25f9b1abce1e551e6c793406a093c93ea12cce54ed0342d329d0e29c10832');
    assert.equal(receipt.manifestDigestHex, index === 0 ? '34bde203e4ad5c70d6039ea43c8c93ce2b8056a5335c7e450177a6793680e20d' : '7da121c6ee77575457509d33540d6c2e5c8df88263751a22e65cb3baeb474890');
    assert.deepEqual([receipt.txid, receipt.blockHeight], [acceptance.transactions[index].txid, acceptance.transactions[index].blockHeight]);
    const changed = receipt.memoHex.slice(0, -2) + (receipt.memoHex.endsWith('00') ? 'ff' : '00');
    assert.equal(verifyReceiptHex(changed).valid, false);
  });
});

test('native memo archive matches the continuous viewing-only scan and its digest', () => {
  const raw = readFileSync('docs/evidence/native-live-memo-scan.json', 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(raw).digest('hex'), nativeArchive.provenance.rawScanSha256);
  const scan = JSON.parse(raw);
  assert.equal(scan.adapter, 'testnet-chain');
  assert.equal(scan.complete, true);
  assert.equal(scan.blocks[0].previous_hash_hex, nativeArchive.provenance.expectedPreviousHash);
  assert.equal(scan.blocks[0].height, nativeArchive.provenance.scanStartHeight);
  assert.equal(scan.blocks.at(-1).height, nativeArchive.provenance.scanEndHeight);
  for (let i = 1; i < scan.blocks.length; i++) {
    assert.equal(scan.blocks[i].height, scan.blocks[i - 1].height + 1);
    assert.equal(scan.blocks[i].previous_hash_hex, scan.blocks[i - 1].hash_hex);
  }
  for (const receipt of NATIVE_MEMO_RECEIPTS) {
    const block = scan.blocks.find((b: { height: number }) => b.height === receipt.blockHeight);
    assert.equal(block.hash_hex, receipt.blockHash);
    const tx = block.transactions.find((t: { txid_hex: string }) => t.txid_hex === receipt.txid);
    assert.equal(tx.tx_index, receipt.transactionIndex);
    const output = tx.outputs.find((o: { output_index: number }) => o.output_index === receipt.outputIndex);
    assert.equal(output.memo_hex, receipt.memoHex);
  }
});

test('every recorded transport memo verifies and matches its recorded operation', () => {
  assert.equal(TRANSPORT_RECEIPTS.length, 3);
  const expected = [['REGISTER', '0'], ['POSTPONE', '1'], ['CANCEL', '2']];
  TRANSPORT_RECEIPTS.forEach((receipt, i) => {
    const result = verifyReceiptHex(receipt.memoHex);
    assert.equal(result.valid, true, result.errorMessage);
    assert.equal(result.operation, receipt.operation);
    assert.deepEqual([result.operation, result.sequence], expected[i]);
  });
});

test('all three transport memos belong to one switch and one signing key', () => {
  const results = TRANSPORT_RECEIPTS.map(r => verifyReceiptHex(r.memoHex));
  assert.equal(new Set(results.map(r => r.switchIdHex)).size, 1);
  assert.equal(new Set(results.map(r => r.sourcePubKeyHex)).size, 1);
  assert.equal(new Set(results.map(r => r.manifestDigestHex)).size, 1);
});

test('tampered or malformed receipts are rejected with a reason', () => {
  const good = TRANSPORT_RECEIPTS[0].memoHex;
  const flippedSignature = good.slice(0, -2) + (good.endsWith('00') ? 'ff' : '00');
  assert.equal(verifyReceiptHex(flippedSignature).errorCode, 'ERR_MEMO_BAD_SIGNATURE');
  assert.equal(verifyReceiptHex(good.slice(2)).valid, false);
  assert.equal(verifyReceiptHex('zz').errorCode, 'ERR_NOT_HEX');
  assert.equal(verifyReceiptHex('').valid, false);
});

test('whitespace and 0x prefix are tolerated', () => {
  const good = TRANSPORT_RECEIPTS[1].memoHex;
  assert.equal(verifyReceiptHex(`0x${good.slice(0, 100)}\n${good.slice(100)}`).valid, true);
});

test('bundled evidence matches the committed JSON files', () => {
  TRANSPORT_RECEIPTS.forEach((receipt, i) => {
    assert.equal(receipt.memoHex, transport[i].raw_memo_hex);
    assert.equal(receipt.txid, transport[i].txid);
    assert.equal(receipt.blockHeight, transport[i].block_height);
  });
  assert.deepEqual(
    NATIVE_RUN_TRANSACTIONS.map(t => [t.txid, t.blockHeight]),
    acceptance.transactions.map((t: { txid: string; blockHeight: number }) => [t.txid, t.blockHeight]),
  );
  assert.deepEqual(NATIVE_RUN_CHECKS, acceptance.checks.map((c: { name: string }) => c.name));
});
