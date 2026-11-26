//! Machine-checked proofs of the money and fairness rules, run with the Kani model checker:
//!
//! ```text
//! cargo kani -p ajo
//! ```
//!
//! Each harness covers every input in its stated bounds, not a sample.

use super::*;

fn circle_with(n: usize) -> Circle {
    Circle {
        creator: Pubkey::default(),
        circle_id: 0,
        name: String::new(),
        mint: Pubkey::default(),
        vault: Pubkey::default(),
        token_program: Pubkey::default(),
        contribution: 1,
        late_fee: 0,
        round_secs: MIN_ROUND_SECS,
        grace_secs: 0,
        capacity: n as u8,
        state: CircleState::Active,
        created_ts: 0,
        start_ts: 0,
        round: 0,
        paid_mask: 0,
        members: (0..n).map(|i| Pubkey::new_from_array([i as u8 + 1; 32])).collect(),
        order: Vec::new(),
        missed: vec![0; n],
        total_paid_out: 0,
        bump: 0,
        vault_bump: 0,
    }
}

/// Every member collects exactly once: for circles of up to 6 members and any
/// stream of random words (so whatever the seed hashes to), the shuffle that
/// `draw_order` uses returns a permutation of the member indexes. Sizes 7 to
/// 12 are covered by the 100k-seed brute-force test in `tests/rules.rs`; the
/// 64-bit `%` makes larger bounds too big for the model checker.
#[kani::proof]
#[kani::unwind(7)]
fn draw_order_is_a_permutation() {
    let n: usize = kani::any();
    kani::assume((MIN_MEMBERS..=6).contains(&n));
    let order = shuffle(n, || kani::any());
    assert!(order.len() == n);
    let mut seen = [false; 6];
    for &i in &order {
        assert!((i as usize) < n);
        assert!(!seen[i as usize]);
        seen[i as usize] = true;
    }
}

/// A round only counts as fully paid when exactly the members' bits are set,
/// and the check never panics for any circle size the program allows.
#[kani::proof]
#[kani::unwind(14)]
fn all_paid_means_every_member_paid() {
    let n: usize = kani::any();
    kani::assume((1..=MAX_MEMBERS).contains(&n));
    let mut c = circle_with(n);
    c.paid_mask = kani::any();
    let every_bit = (0..n).all(|i| c.paid_mask & (1 << i) != 0);
    let no_extra = c.paid_mask >> n == 0;
    assert!(c.all_paid() == (every_bit && no_extra));
}

/// On time you pay the contribution; late you pay the contribution plus the
/// late fee, never anything else, and the sum cannot overflow under the
/// limits `create_circle` enforces.
#[kani::proof]
fn amount_owed_is_exact() {
    let now: i64 = kani::any();
    let due: i64 = kani::any();
    let contribution: u64 = kani::any();
    let late_fee: u64 = kani::any();
    kani::assume(late_fee <= contribution && contribution <= u64::MAX / 2);
    let (amount, late) = amount_owed(now, due, contribution, late_fee).unwrap();
    if now > due {
        assert!(late && amount == contribution + late_fee);
    } else {
        assert!(!late && amount == contribution);
    }
}

/// Due times are exact and strictly increase round by round, with no overflow,
/// for every start time up to 2^40 and every allowed round length.
#[kani::proof]
fn round_due_is_exact_and_increasing() {
    let start: i64 = kani::any();
    let secs: i64 = kani::any();
    let round: u8 = kani::any();
    kani::assume((0..=1i64 << 40).contains(&start));
    kani::assume((MIN_ROUND_SECS..=MAX_ROUND_SECS).contains(&secs));
    kani::assume((round as usize) < MAX_MEMBERS);
    let due = round_due(start, round, secs).unwrap();
    assert!(due == start + (round as i64 + 1) * secs);
    if (round as usize) + 1 < MAX_MEMBERS {
        assert!(round_due(start, round + 1, secs).unwrap() > due);
    }
}

/// The pot for round r goes to `members[order[r]]`, and asking for the
/// recipient never panics, even on a malformed order.
#[kani::proof]
#[kani::unwind(4)]
fn current_recipient_follows_the_order() {
    let n: usize = kani::any();
    kani::assume((MIN_MEMBERS..=3).contains(&n));
    let mut c = circle_with(n);
    let len: usize = kani::any();
    kani::assume(len <= 3);
    let raw: [u8; 3] = kani::any();
    c.order = raw[..len].to_vec();
    c.round = kani::any();
    let got = c.current_recipient();
    // Member i's key is [i + 1; 32] and the default key is all zeros, so the
    // first byte identifies the key (and avoids a 32-byte memcmp loop).
    let first = got.to_bytes()[0];
    match c.order.get(c.round as usize) {
        Some(&i) if (i as usize) < n => assert!(first == i + 1),
        _ => assert!(first == 0),
    }
}
