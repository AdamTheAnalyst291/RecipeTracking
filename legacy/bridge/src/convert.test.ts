import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Transaction } from 'plaid';
import { postedFor, toActual, toCents } from './convert.js';

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    transaction_id: 't1',
    account_id: 'checking',
    amount: 12.34,
    date: '2026-10-30',
    name: 'KROGER #123',
    merchant_name: 'Kroger',
    pending: false,
    ...over,
  }) as Transaction;

test('Plaid outflows become negative cents, inflows positive', () => {
  assert.equal(toCents(12.34), -1234);
  assert.equal(toCents(-2500), 250000);
  assert.equal(toCents(0.1 + 0.2), -30);
});

test('maps fields and prefixes the imported id', () => {
  assert.deepEqual(toActual(tx({}), 'acct-1'), {
    account: 'acct-1',
    date: '2026-10-30',
    amount: -1234,
    payee_name: 'Kroger',
    imported_payee: 'KROGER #123',
    imported_id: 'plaid:t1',
    cleared: true,
  });
  assert.equal(toActual(tx({ merchant_name: null }), 'a').payee_name, 'KROGER #123');
});

test('skips pending, unmapped and skipped accounts', () => {
  const map = new Map([
    ['checking', 'acct-1'],
    ['savings', 'skip'],
  ]);
  const out = postedFor(
    [
      tx({ transaction_id: 'a' }),
      tx({ transaction_id: 'b', pending: true }),
      tx({ transaction_id: 'c', account_id: 'savings' }),
      tx({ transaction_id: 'd', account_id: 'card' }),
    ],
    map,
  );
  assert.deepEqual([...out.keys()], ['acct-1']);
  assert.deepEqual(out.get('acct-1')!.map((r) => r.imported_id), ['plaid:a']);
});
