import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSPORT_RECEIPTS, NATIVE_RUN_TRANSACTIONS, NATIVE_RUN_CHECKS } from '../src/evidence/recordedRun';
import { verifyReceiptHex } from '../src/evidence/verifyReceipt';

const transport = JSON.parse(readFileSync('docs/evidence/testnet-transport.json', 'utf8'));
const acceptance = JSON.parse(readFileSync('docs/evidence/native-live-acceptance.json', 'utf8'));

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
