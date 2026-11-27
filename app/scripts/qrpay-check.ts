/// <reference types="node" />
// Manual check of the app's Solana Pay card. `setup` makes an active circle with a member whose key
// is saved to $KEYFILE; open the circle in the app, decode the QR, then `pay <solana: link>` acts as
// the scanning wallet against the deployed endpoint. The app should then show "payment received".
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import * as ajo from '../src/ajo';

const conn = new Connection(process.env.RPC ?? ajo.DEVNET_RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const KEYFILE = process.env.KEYFILE ?? 'qrpay-member.json';

async function setup() {
  const member = Keypair.generate();
  writeFileSync(KEYFILE, JSON.stringify(Array.from(member.secretKey)));
  const go = (ixs: any[], s: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), s, { commitment: 'confirmed' });
  await go([
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: member.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(member.publicKey), member.publicKey, ajo.USDC_MINT),
    createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(member.publicKey), payer.publicKey, 20_000_000n, ajo.USDC_DECIMALS),
  ], [payer]);
  const circleId = BigInt(Date.now());
  const circle = ajo.circlePda(payer.publicKey, circleId);
  await go([ajo.createCircleIx(payer.publicKey, { circleId, name: process.env.NAME ?? 'QR pay check', contribution: 10_000_000n, capacity: 2, roundSecs: 3600, graceSecs: 600, lateFee: 1_000_000n })], [payer]);
  await go([ajo.joinIx(member.publicKey, circle)], [payer, member]);
  await go([ajo.startIx(payer.publicKey, circle)], [payer]);
  console.log(circle.toBase58());
}

async function pay(link: string) {
  const member = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYFILE, 'utf8'))));
  const url = decodeURIComponent(link.replace(/^solana:/, ''));
  const label = await (await fetch(url)).json();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: member.publicKey.toBase58() }) });
  const body = await res.json();
  console.log(label.label, '|', res.status, body.message);
  if (!body.transaction) process.exit(1);
  const tx = Transaction.from(Buffer.from(body.transaction, 'base64'));
  tx.sign(member);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(ajo.explorerTx(sig));
}

(process.argv[2] === 'pay' ? pay(process.argv[3]) : setup()).catch((e) => { console.error(e); process.exit(1); });
