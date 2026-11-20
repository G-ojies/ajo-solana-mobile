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

### Known limits

- The payout order resists a careless creator, not members who grind keypairs before joining.
- Fee-on-transfer mints are rejected; mints with a transfer hook are not supported. Use plain USDC.
- Tokens sent straight to the vault after a circle ends block `close_circle` (only the rent is affected).

## App (`app/`)

Expo (SDK 58, React Native 0.88) custom dev build with Solana Mobile's Mobile Wallet Adapter
(`@wallet-ui/react-native-web3js`). Members sign every action in their phone wallet; there is no
browser extension and no server.

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

Before the event (allowed by the FAQ): the program and its tests, the app's first version, the scripts
and the screen design.
During the event: listed here as it happens.

## License

MIT
