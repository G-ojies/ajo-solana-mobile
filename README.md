# Ajo on Solana Mobile

**[Project page](https://g-ojies.github.io/ajo-solana-mobile/)** · **[Download the Android app (devnet)](https://github.com/G-ojies/ajo-solana-mobile/releases/latest)**

The rotating savings circle (ajo, esusu, susu) with the pot held by a Solana program instead of a person.

Every member pays a fixed amount each round. When everyone has paid, anyone can send the whole pot to
that round's member. The payout order is drawn from public data when the circle starts, so anyone can
recompute it. No admin key, no fee, and the creator cannot touch the pot.

## Program (`onchain/programs/ajo`)

Anchor 1.0. **Live on devnet:** program [`66oEASieGnPhV51Xi1TVWFhotG3TfjpBYXHVUPpVXF7b`](https://explorer.solana.com/address/66oEASieGnPhV51Xi1TVWFhotG3TfjpBYXHVUPpVXF7b?cluster=devnet).
Test USDC mint (devnet): `234ncajJBfiu5MZwZqExTjhzhotgWz1nqWJjzR6KpqMJ`.

| Instruction | Who | What |
|---|---|---|
| `create_circle` | creator | Name, amount, 2 to 12 members, round length, grace, late fee. Creates the circle PDA and its token vault. Creator is member 0. |
| `join` | anyone | While forming, until full. |
| `start` | creator | Needs 2+ members. Draws the payout order, round 0 starts now. |
| `contribute` | member | Pays the round's amount straight into the vault (plus the late fee if past due). |
| `payout` | anyone | Once everyone has paid, or after due + grace: the whole vault goes to the round's member; unpaid members are recorded in `missed`. Next round begins. |
| `close_circle` | creator | Forming (nothing held yet) or done. Closes the empty vault and the circle. |

Accounts: `Circle` PDA `["circle", creator, circle_id]`, vault token account PDA `["vault", circle]`
owned by the circle.

### Build and test

```
cd onchain/programs/ajo
cargo build-sbf --tools-version v1.52
cargo test --release
```

14 LiteSVM tests cover a full circle (everyone collects once and breaks even) on SPL Token and Token-2022,
every validation error, late fees, forced payout after grace, and payouts to the wrong member, wallet
or mint.

5 more tests (`tests/rules.rs`) check the money and fairness rules by brute force: 1.1 million payout
orders (100,000 per circle size, 2 to 12 members) all give every member exactly one turn, no member index
collects first more than 5% above or below its fair share over 120,000 circles per size, "everyone has
paid" holds for exactly one of the 65,536 paid masks at each size, and late fees and due times cannot
overflow at the program's limits.

5 Kani proofs (`src/proofs.rs`, run with `cargo kani -p ajo`) check the same rules for every input
within stated bounds, not a sample: the shuffle behind the payout order gives every member exactly one
turn for any random words (2 to 6 members), "everyone has paid" is exact for every mask (up to 12
members), the amount owed is the contribution plus the late fee only when late and cannot overflow,
due times are exact and strictly increase, and the pot's recipient lookup never panics. Larger circle
sizes for the shuffle are covered by the brute-force test above; the 64-bit arithmetic makes them too
big for the model checker.

### Known limits

- The payout order resists a careless creator, not members who grind keypairs before joining.
- Fee-on-transfer mints are rejected; mints with a transfer hook are not supported. Use plain USDC.
- Tokens sent straight to the vault after a circle ends block `close_circle` (only the rent is affected).

## App (`app/`)

Native Android app: an Expo (SDK 58, React Native 0.88) custom dev build with Solana Mobile's Mobile
Wallet Adapter (`@wallet-ui/react-native-web3js`). Members sign every action in their phone wallet;
there is no browser extension, no web view and no server.

**Template.** The app was not generated with `npx solana-mobile create`. It was set up by hand before
the hackathon, on the same stack as Solana Mobile's official
[`expo-web3js-minimal`](https://github.com/solana-mobile/templates/tree/main/mobile/expo-web3js-minimal)
template: Expo 58, React Native 0.88, `@wallet-ui/react-native-web3js` 4.4.1 for MWA, web3.js v1 and
`react-native-quick-crypto` with `react-native-nitro-modules`. It leaves out the template's
expo-router, React Query and UI libraries and uses plain state-based navigation instead.

Screens: my circles, start a circle, join by code, QR code or invite link (`g-ojies.github.io/ajo-solana-mobile/join/?c=<circle>`, a page that reads the circle from devnet and opens the app), the circle (dial of who
has paid, pay my contribution, send the pot, payout order, on-chain history with explorer links) and settings.

`app/src/ajo.ts` is a dependency-light client for the program (web3.js v1 + spl-token) shared by the
app and the Node scripts.

```
cd app
npm install
npx expo run:android        # needs Node >= 22.13, JDK 17, an emulator or device with an MWA wallet
npx tsx scripts/e2e.ts      # full 3-member circle on devnet (RPC=... to point elsewhere; runs on Node 20)
npx tsx scripts/fund.ts <address> [usdc] [sol]   # give a demo wallet test USDC and SOL
```

Verified on devnet (18 Nov 2026):
- `scripts/e2e.ts`: a 3-member circle, 3 rounds, each member collected 30 USDC once
  (circle [`xoPDWK…`](https://explorer.solana.com/address/xoPDWKWEGhyrb1FZC6bztoi4Ys9mrx6AaFwjM1L7dq3?cluster=devnet)).
- In the app on an Android emulator with Solana Mobile's mock MWA wallet: created a 2-member circle,
  a second member joined by code, started, paid, sent the pot, second round, finished
  (circle `6piiH4…`). Every step signed in the phone wallet.

`scripts/member.ts <n> join|pay|payout <code>` plays the other members from the command line.

## Built before vs during Dev3pack (27 to 29 Nov 2026)

Before the event (allowed by the FAQ): the program and its tests, the app's first version (set up by
hand, not from a template, see "Template" above), the scripts and the screen design.
During the event (27 to 29 Nov): **Solana Pay.** A member can pay their round from any wallet that
supports Solana Pay transaction requests, by scanning a QR in the app (on an active circle) or on the
circle's web page. A small serverless endpoint, [`api/pay.ts`](api/pay.ts), builds the same `contribute`
transaction the app sends. The wallet is the only signer and the fee payer, so the server holds no keys,
and the program did not change. A random reference key in the link lets the app notice the payment.
- `app/scripts/refcheck.ts`: on devnet, `contribute` with an extra reference key still succeeds and the
  reference finds the transaction.
- `app/scripts/paytx.ts`: acts as the wallet against the endpoint on devnet. It covers the label and
  icon, refusals (bad or unknown circle, non-member, not enough USDC, already paid), and a signed
  payment that sets the paid bit and is found by its reference. 15 checks.
- `app/scripts/qrpay-check.ts`: with v0.3.0 on an Android emulator, the QR the app shows was decoded and
  paid through the deployed endpoint; the app picked up the payment by its reference within seconds,
  showed "1 payment received" and moved to a fresh reference for the next member.
- Status: endpoint tested with a Node signer acting as the wallet; scanning with a real wallet app is
  still pending.

## License

MIT
