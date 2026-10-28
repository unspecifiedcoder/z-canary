import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildZip321RegistrationRequest,
  formatZatoshiAmount,
  normalizeTestnetTxid,
  testnetExplorerUrl,
} from '../src/zcash/zip321';

const ADDRESS = 'utest170vmkzw3hjx8yltquph5pr7d32j097g7nwq7xty2kr04us00g96fc3kf7dpp0qk6sa4rmem00dhvznxsnxc48ss33xjfd0w7s3kdy2y9qzrrjkd9gu8x9xspgzv583fq6e9nhyp5cwe5uyxuqx8d8ctw0930678aamn2u7dqxqa0hwcq';
const MEMO_HEX = 'ff' + '00'.repeat(511);

test('formats zatoshi without floating point rounding', () => {
  assert.equal(formatZatoshiAmount(10_000), '0.00010000');
  assert.equal(formatZatoshiAmount(100_000_001), '1.00000001');
  assert.throws(() => formatZatoshiAmount(0), /positive whole number/);
});

test('builds a ZIP-321 request with an exact 512-byte base64url memo', () => {
  const request = buildZip321RegistrationRequest({
    address: ADDRESS,
    amountZatoshi: 10_000,
    memoHex: MEMO_HEX,
  });
  assert.equal(request.amountZec, '0.00010000');
  assert.match(request.memoBase64Url, /^[A-Za-z0-9_-]+$/);
  assert.equal(request.memoBase64Url.includes('='), false);
  assert.equal(request.uri, `zcash:${ADDRESS}?amount=0.00010000&memo=${request.memoBase64Url}&message=Canary%20REGISTER%20command%20(Zcash%20testnet)`);

  const padded = request.memoBase64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(request.memoBase64Url.length / 4) * 4, '=');
  assert.equal(Buffer.from(padded, 'base64').toString('hex'), MEMO_HEX);
});

test('rejects invalid payment inputs and validates explorer transaction IDs', () => {
  assert.throws(() => buildZip321RegistrationRequest({ address: 'tmock', amountZatoshi: 10_000, memoHex: MEMO_HEX }), /Unified Address/);
  assert.throws(() => buildZip321RegistrationRequest({ address: ADDRESS, amountZatoshi: 10_000, memoHex: 'ff' }), /512 bytes/);
  const txid = 'ab'.repeat(32);
  assert.equal(normalizeTestnetTxid(` ${txid.toUpperCase()} `), txid);
  assert.equal(normalizeTestnetTxid('not-a-txid'), null);
  assert.equal(testnetExplorerUrl(txid), `https://testnet.zecblock.com/tx/${txid}`);
});
