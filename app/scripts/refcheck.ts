/// <reference types="node" />
// Devnet check for Solana Pay: `contribute` with one extra read-only "reference" key appended must
// still succeed, and the reference must find the transaction. Run: npx tsx scripts/refcheck.ts
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

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  console.log(`${label.padEnd(16)} ${ajo.explorerTx(sig)}`);
  return sig;
}

async function main() {
  const member = Keypair.generate();
  await send('fund member', [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: member.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(member.publicKey), member.publicKey, ajo.USDC_MINT),
    createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(member.publicKey), payer.publicKey, 20_000_000n, ajo.USDC_DECIMALS),
  ], [payer]);

  const circleId = BigInt(Date.now());
  const circle = ajo.circlePda(payer.publicKey, circleId);
  await send('create_circle', [ajo.createCircleIx(payer.publicKey, {
    circleId, name: 'Solana Pay ref check', contribution: 10_000_000n, capacity: 2, roundSecs: 600, graceSecs: 60, lateFee: 0n,
  })], [payer]);
  await send('join', [ajo.joinIx(member.publicKey, circle)], [payer, member]);
  await send('start', [ajo.startIx(payer.publicKey, circle)], [payer]);

  // The member pays as its own fee payer, exactly as a wallet would sign a transaction request.
  const c = (await ajo.fetchCircle(conn, circle))!;
  const reference = Keypair.generate().publicKey;
  const ix = ajo.contributeIx(member.publicKey, c);
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  const sig = await send('contribute+ref', [ix], [member]);

  const after = (await ajo.fetchCircle(conn, circle))!;
  const i = after.members.findIndex((m) => m.equals(member.publicKey));
  const found = await conn.getSignaturesForAddress(reference, { limit: 5 }, 'confirmed');
  console.log('paid bit set   ', ajo.hasPaid(after, i));
  console.log('reference finds', found.map((s) => s.signature).includes(sig) ? 'the tx' : `NOT FOUND (${found.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
