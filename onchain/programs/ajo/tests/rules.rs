//! Exhaustive and large-sample checks of the pure rules, on the host.
//! The Kani proofs in src/proofs.rs cover the same rules symbolically.

use ajo::{amount_owed, draw_order, round_due, Circle, CircleState, MAX_MEMBERS, MIN_MEMBERS};
use anchor_lang::prelude::Pubkey;

fn circle_with(n: usize, paid_mask: u16) -> Circle {
    Circle {
        creator: Pubkey::default(),
        circle_id: 0,
        name: String::new(),
        mint: Pubkey::default(),
        vault: Pubkey::default(),
        token_program: Pubkey::default(),
        contribution: 1,
        late_fee: 0,
        round_secs: 60,
        grace_secs: 0,
        capacity: n as u8,
        state: CircleState::Active,
        created_ts: 0,
        start_ts: 0,
        round: 0,
        paid_mask,
        members: (0..n).map(|i| Pubkey::new_from_array([i as u8 + 1; 32])).collect(),
        order: Vec::new(),
        missed: vec![0; n],
        total_paid_out: 0,
        bump: 0,
        vault_bump: 0,
    }
}

/// Deterministic pseudo-random seeds shaped like the real ones: 32 bytes per member plus the circle key.
fn seed(k: u64, n: usize) -> Vec<u8> {
    let mut x = k.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    (0..32 * (n + 1))
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

#[test]
fn every_member_collects_exactly_once_for_100k_seeds_per_size() {
    for n in MIN_MEMBERS..=MAX_MEMBERS {
        for k in 0..100_000u64 {
            let mut o = draw_order(&seed(k, n), n);
            o.sort_unstable();
            assert_eq!(o, (0..n as u8).collect::<Vec<_>>(), "n={n} k={k}");
        }
    }
}

#[test]
fn no_member_is_favoured_for_the_first_payout() {
    // Over 120k circles of each size, every member index should collect first about 1/n of the time.
    for n in MIN_MEMBERS..=MAX_MEMBERS {
        let trials = 120_000u64;
        let mut first = vec![0u64; n];
        for k in 0..trials {
            first[draw_order(&seed(k, n), n)[0] as usize] += 1;
        }
        let expected = trials as f64 / n as f64;
        for (i, &c) in first.iter().enumerate() {
            let dev = (c as f64 - expected).abs() / expected;
            assert!(dev < 0.05, "n={n}: member {i} first {c} times, expected ~{expected:.0}");
        }
    }
}

#[test]
fn all_paid_exactly_when_every_member_bit_is_set_every_mask() {
    for n in 1..=MAX_MEMBERS {
        for mask in 0..=u16::MAX {
            let want = mask == ((1u32 << n) - 1) as u16;
            assert_eq!(circle_with(n, mask).all_paid(), want, "n={n} mask={mask:#06x}");
        }
    }
}

#[test]
fn amount_owed_edges() {
    let c = u64::MAX / 2;
    assert_eq!(amount_owed(i64::MIN, i64::MAX, c, c), Some((c, false)));
    assert_eq!(amount_owed(i64::MAX, i64::MIN, c, c), Some((c + c, true)));
    assert_eq!(amount_owed(0, 0, 5, 5), Some((5, false)), "paying exactly at the due time is on time");
}

#[test]
fn round_due_never_overflows_at_the_limits() {
    let start = 1i64 << 40;
    let mut last = start;
    for r in 0..MAX_MEMBERS as u8 {
        let d = round_due(start, r, ajo::MAX_ROUND_SECS).unwrap();
        assert!(d > last);
        last = d;
    }
}
