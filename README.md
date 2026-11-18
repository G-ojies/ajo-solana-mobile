# Ajo on Solana Mobile

The rotating savings circle (ajo, esusu, susu) with the pot held by a Solana program instead of a person.

Every member pays a fixed amount each round. When everyone has paid, anyone can send the whole pot to
that round's member. The payout order is drawn from public data when the circle starts, so anyone can
recompute it. No admin key, no fee, and the creator cannot touch the pot.

## Program (`onchain/programs/ajo`)

Anchor 1.0. Devnet program id: `66oEASieGnPhV51Xi1TVWFhotG3TfjpBYXHVUPpVXF7b` (deploy pending).

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

## Built before vs during Dev3pack (27 to 29 Nov 2026)

Before the event (allowed by the FAQ): the program, its tests, and the screen design.
During the event: listed here as it happens.

## License

MIT
