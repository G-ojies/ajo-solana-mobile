/// <reference types="node" />
// Full circle on devnet with three wallets: the local CLI wallet (creator) and two
// fresh members it funds. Prints every signature. Run: npx tsx scripts/e2e.ts
import { readFileSync } from 'fs';
import { homedir } from 'os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import * as ajo from '../src/ajo';

const conn = new Connection(process.env.RPC ?? ajo.DEVNET_RPC, 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))),
);

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  console.log(`${label.padEnd(22)} ${ajo.explorerTx(sig)}`);
  return sig;
}

async function main() {
  const members = [Keypair.generate(), Keypair.generate()];
  const contribution = 10_000_000n; // 10 test USDC
  for (const m of members) {
    await send(`fund ${m.publicKey.toBase58().slice(0, 6)}`, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(m.publicKey), m.publicKey, ajo.USDC_MINT),
      createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(m.publicKey), payer.publicKey, 50_000_000n, ajo.USDC_DECIMALS),
    ], [payer]);
  }

  const circleId = BigInt(Date.now());
  const circle = ajo.circlePda(payer.publicKey, circleId);
  await send('create_circle', [ajo.createCircleIx(payer.publicKey, {
    circleId, name: 'Devnet e2e circle', contribution, capacity: 3, roundSecs: 60, graceSecs: 30, lateFee: 1_000_000n,
  })], [payer]);
  for (const m of members) await send('join', [ajo.joinIx(m.publicKey, circle)], [payer, m]);
  await send('start', [ajo.startIx(payer.publicKey, circle)], [payer]);

  const everyone = [payer, ...members];
  let c = (await ajo.fetchCircle(conn, circle))!;
  console.log('order', c.order.map((i) => c.members[i].toBase58().slice(0, 6)).join(' -> '));
  for (let round = 0; round < 3; round++) {
    for (const k of everyone) {
      c = (await ajo.fetchCircle(conn, circle))!;
      await send(`r${round} pay ${k.publicKey.toBase58().slice(0, 6)}`, [ajo.contributeIx(k.publicKey, c)], [payer, k].filter((x, i, a) => a.indexOf(x) === i));
    }
    c = (await ajo.fetchCircle(conn, circle))!;
    const r = c.members[ajo.recipientIndex(c)!];
    const before = (await conn.getTokenAccountBalance(ajo.ata(r))).value.amount;
    await send(`r${round} payout`, ajo.payoutIxs(payer.publicKey, c), [payer]);
    const after = (await conn.getTokenAccountBalance(ajo.ata(r))).value.amount;
    console.log(`  ${r.toBase58().slice(0, 6)} collected ${ajo.formatUsdc(BigInt(after) - BigInt(before))} USDC`);
  }
  c = (await ajo.fetchCircle(conn, circle))!;
  console.log('state', c.state, 'total paid out', ajo.formatUsdc(c.totalPaidOut));
  const hist = await ajo.fetchHistory(conn, circle, 40);
  console.log('history kinds', hist.map((h) => h.kind).reverse().join(','));
  if (!process.env.KEEP) await send('close_circle', [ajo.closeCircleIx(payer.publicKey, c)], [payer]);
  console.log('circle', circle.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
