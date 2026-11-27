/// <reference types="node" />
// End-to-end test of the Solana Pay endpoint on devnet, acting as the wallet would:
// GET the label, POST {account}, sign the returned transaction with the member key only, send it,
// then confirm the paid bit and the reference lookup. Also checks the refusals.
//   PAY_URL=https://<host>/api/pay npx tsx scripts/paytx.ts    (deployed endpoint)
//   npx tsx scripts/paytx.ts                                   (calls api/pay.ts in-process)
import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import * as ajo from '../src/ajo';

const conn = new Connection(process.env.RPC ?? ajo.DEVNET_RPC, 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))),
);
const PAY_URL = process.env.PAY_URL ?? 'http://local/api/pay';

async function call(method: 'GET' | 'POST', query: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const url = `${PAY_URL}?${query}`;
  let res: Response;
  if (process.env.PAY_URL) {
    res = await fetch(url, init);
  } else {
    const api = await import('../../api/pay');
    res = method === 'GET' ? api.GET() : await api.POST(new Request(url, init));
  }
  return { status: res.status, json: await res.json() };
}

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  console.log(`${label.padEnd(16)} ${ajo.explorerTx(sig)}`);
  return sig;
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  console.log('endpoint', process.env.PAY_URL ?? 'api/pay.ts in-process');
  const member = Keypair.generate();
  const broke = Keypair.generate(); // a member with SOL but no USDC
  const outsider = Keypair.generate();
  await send('fund members', [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: member.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: broke.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(member.publicKey), member.publicKey, ajo.USDC_MINT),
    createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(member.publicKey), payer.publicKey, 20_000_000n, ajo.USDC_DECIMALS),
  ], [payer]);

  const circleId = BigInt(Date.now());
  const circle = ajo.circlePda(payer.publicKey, circleId);
  await send('create_circle', [ajo.createCircleIx(payer.publicKey, {
    circleId, name: 'Solana Pay test', contribution: 10_000_000n, capacity: 3, roundSecs: 600, graceSecs: 60, lateFee: 0n,
  })], [payer]);
  const q = `circle=${circle.toBase58()}`;

  let r = await call('POST', q, { account: member.publicKey.toBase58() });
  check('refuses before the circle starts', r.status === 400, r.json.message);
  await send('join member', [ajo.joinIx(member.publicKey, circle)], [payer, member]);
  await send('join broke', [ajo.joinIx(broke.publicKey, circle)], [payer, broke]);
  await send('start', [ajo.startIx(payer.publicKey, circle)], [payer]);

  r = await call('GET', q);
  check('GET label and icon', r.status === 200 && r.json.label === 'Ajo' && /^https:/.test(r.json.icon), JSON.stringify(r.json));
  r = await call('POST', 'circle=nope', { account: member.publicKey.toBase58() });
  check('refuses a bad circle address', r.status === 400, r.json.message);
  r = await call('POST', `circle=${Keypair.generate().publicKey.toBase58()}`, { account: member.publicKey.toBase58() });
  check('refuses an unknown circle', r.status === 404, r.json.message);
  r = await call('POST', q, { account: outsider.publicKey.toBase58() });
  check('refuses a non-member', r.status === 400, r.json.message);
  r = await call('POST', q, { account: broke.publicKey.toBase58() });
  check('refuses a member without enough USDC', r.status === 400 && /Not enough USDC/.test(r.json.message), r.json.message);
  r = await call('POST', q, {});
  check('refuses a missing account', r.status === 400, r.json.message);

  const reference = Keypair.generate().publicKey;
  r = await call('POST', `${q}&reference=${reference.toBase58()}`, { account: member.publicKey.toBase58() });
  check('member gets a transaction', r.status === 200 && typeof r.json.transaction === 'string', r.json.message);
  const tx = Transaction.from(Buffer.from(r.json.transaction, 'base64'));
  check('fee payer is the wallet', tx.feePayer?.equals(member.publicKey) === true);
  check('only the wallet signs', tx.signatures.length === 1 && tx.signatures[0].publicKey.equals(member.publicKey));
  tx.sign(member);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`${'wallet sends'.padEnd(16)} ${ajo.explorerTx(sig)}`);

  const c = (await ajo.fetchCircle(conn, circle))!;
  check('paid bit set', ajo.hasPaid(c, c.members.findIndex((m) => m.equals(member.publicKey))));
  const found = await conn.getSignaturesForAddress(reference, { limit: 5 }, 'confirmed');
  check('reference finds the payment', found.some((s) => s.signature === sig));
  r = await call('POST', q, { account: member.publicKey.toBase58() });
  check('refuses a second payment for the round', r.status === 400, r.json.message);

  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
