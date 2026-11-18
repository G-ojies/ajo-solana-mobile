/// <reference types="node" />
// Give a demo wallet some devnet SOL and test USDC from the local CLI wallet.
// Run: npx tsx scripts/fund.ts <address> [usdc=100] [sol=0.05]
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import * as ajo from '../src/ajo';

const [addr, usdc = '100', sol = '0.05'] = process.argv.slice(2);
if (!addr) throw new Error('usage: fund.ts <address> [usdc] [sol]');
const to = new PublicKey(addr);
const conn = new Connection(process.env.RPC ?? ajo.DEVNET_RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));
const tx = new Transaction().add(
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: Math.round(Number(sol) * LAMPORTS_PER_SOL) }),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(to), to, ajo.USDC_MINT),
  createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(to), payer.publicKey, ajo.parseUsdc(usdc)!, ajo.USDC_DECIMALS),
);
sendAndConfirmTransaction(conn, tx, [payer]).then((s) => console.log(ajo.explorerTx(s)));
