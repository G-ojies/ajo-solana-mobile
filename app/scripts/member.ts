/// <reference types="node" />
// Play other circle members from the command line (for testing and the demo video).
// Keys live in scripts/.demo-members.json (gitignored) and are funded from the CLI wallet.
//   npx tsx scripts/member.ts <n> join <code|address>
//   npx tsx scripts/member.ts <n> pay <code|address>
//   npx tsx scripts/member.ts <n> payout <code|address>
//   npx tsx scripts/member.ts <n> address
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import * as ajo from '../src/ajo';

const FILE = join(__dirname, '.demo-members.json');
const conn = new Connection(process.env.RPC ?? ajo.DEVNET_RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf8'))));

function members(): number[][] {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
}

async function member(n: number): Promise<Keypair> {
  const all = members();
  while (all.length <= n) all.push(Array.from(Keypair.generate().secretKey));
  writeFileSync(FILE, JSON.stringify(all));
  const kp = Keypair.fromSecretKey(Uint8Array.from(all[n]));
  if ((await conn.getBalance(kp.publicKey)) < 0.01 * LAMPORTS_PER_SOL) {
    await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ajo.ata(kp.publicKey), kp.publicKey, ajo.USDC_MINT),
      createTransferCheckedInstruction(ajo.ata(payer.publicKey), ajo.USDC_MINT, ajo.ata(kp.publicKey), payer.publicKey, 200_000_000n, ajo.USDC_DECIMALS),
    ), [payer]);
    console.log(`funded member ${n} with 0.05 SOL and 200 test USDC`);
  }
  return kp;
}

async function send(kp: Keypair, ixs: TransactionInstruction[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [kp], { commitment: 'confirmed' });
  console.log(ajo.explorerTx(sig));
}

async function main() {
  const [nArg, cmd, code] = process.argv.slice(2);
  const kp = await member(Number(nArg));
  if (cmd === 'address') return console.log(kp.publicKey.toBase58());
  const c = await ajo.findByCode(conn, code ?? '');
  if (!c) throw new Error(`no circle for ${code}`);
  if (cmd === 'join') await send(kp, [ajo.joinIx(kp.publicKey, c.address)]);
  else if (cmd === 'pay') await send(kp, [ajo.contributeIx(kp.publicKey, c)]);
  else if (cmd === 'payout') await send(kp, ajo.payoutIxs(kp.publicKey, c));
  else throw new Error(`unknown command ${cmd}`);
  console.log(`member ${nArg} (${kp.publicKey.toBase58().slice(0, 6)}) ${cmd} ok on ${c.name}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
