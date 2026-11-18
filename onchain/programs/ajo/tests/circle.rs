//! End-to-end tests over LiteSVM. Lifecycle tests run on both SPL Token and Token-2022.

mod common;

use {
    ajo::{draw_order, AjoError, CircleState},
    common::*,
    solana_pubkey::Pubkey,
    solana_signer::Signer,
};

const PROGRAMS: [Pubkey; 2] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

#[test]
fn draw_order_is_a_deterministic_permutation() {
    for n in 2..=12usize {
        let seed: Vec<u8> = (0..n * 32).map(|x| x as u8).collect();
        let a = draw_order(&seed, n);
        let b = draw_order(&seed, n);
        assert_eq!(a, b, "same seed, same order");
        let mut sorted = a.clone();
        sorted.sort();
        assert_eq!(sorted, (0..n as u8).collect::<Vec<_>>(), "permutation of 0..{n}");
    }
    // Different seeds give different orders often enough to matter.
    let distinct: std::collections::HashSet<Vec<u8>> =
        (0u8..50).map(|s| draw_order(&[s; 64], 6)).collect();
    assert!(distinct.len() > 25, "only {} distinct orders from 50 seeds", distinct.len());
}

#[test]
fn amount_owed_adds_late_fee_only_after_due() {
    assert_eq!(ajo::amount_owed(100, 100, 10, 1), Some((10, false)));
    assert_eq!(ajo::amount_owed(101, 100, 10, 1), Some((11, true)));
    assert_eq!(ajo::amount_owed(101, 100, u64::MAX, 1), None);
    assert_eq!(ajo::round_due(1_000, 0, 60), Some(1_060));
    assert_eq!(ajo::round_due(1_000, 2, 60), Some(1_180));
}

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

#[test]
fn full_circle_everyone_collects_once_and_breaks_even() {
    for tp in PROGRAMS {
        let n = 4;
        let mut fx = Fx::running(tp, n);
        let c = fx.state();
        assert_eq!(c.state, CircleState::Active);
        assert_eq!(c.members.len(), n);
        assert_eq!(c.start_ts, NOW);

        // The order anyone can recompute from public data.
        let mut seed = fx.circle.as_ref().to_vec();
        for m in &c.members {
            seed.extend_from_slice(m.as_ref());
        }
        assert_eq!(c.order, draw_order(&seed, n));

        let mut collected = vec![false; n];
        for round in 0..n {
            for i in 0..n {
                fx.contribute(i).unwrap();
            }
            assert_eq!(token_balance(&fx.svm, &fx.vault), CONTRIBUTION * n as u64);
            let r = fx.recipient();
            let before = fx.balance(r);
            fx.payout().unwrap();
            assert_eq!(fx.balance(r), before + CONTRIBUTION * n as u64, "round {round}");
            assert_eq!(token_balance(&fx.svm, &fx.vault), 0);
            assert!(!collected[r], "member {r} collected twice");
            collected[r] = true;
            fx.time(NOW + (round as i64 + 1) * WEEK - DAY); // early in the next round
        }
        assert!(collected.iter().all(|&c| c));

        let c = fx.state();
        assert_eq!(c.state, CircleState::Done);
        assert_eq!(c.round as usize, n);
        assert_eq!(c.total_paid_out, CONTRIBUTION * (n * n) as u64);
        assert!(c.missed.iter().all(|&m| m == 0));
        for i in 0..n {
            assert_eq!(fx.balance(i), START_BALANCE, "member {i} breaks even");
        }

        // Done: no more pay-ins or payouts; the creator closes it and gets the rent back.
        assert_err(fx.contribute(0), AjoError::NotActive);
        // Payout on a finished circle is refused (no current recipient exists).
        let cranker = fx.people[1].kp.insecure_clone();
        let token = fx.people[0].token;
        assert!(fx.payout_to(&cranker, token).is_err());
        let lamports_before = fx.svm.get_balance(&fx.people[0].kp.pubkey()).unwrap();
        fx.close_by(0).unwrap();
        assert!(fx.svm.get_account(&fx.circle).map_or(true, |a| a.lamports == 0));
        assert!(fx.svm.get_account(&fx.vault).map_or(true, |a| a.lamports == 0));
        assert!(fx.svm.get_balance(&fx.people[0].kp.pubkey()).unwrap() > lamports_before);
    }
}

// ---------------------------------------------------------------------------
// create_circle
// ---------------------------------------------------------------------------

#[test]
fn create_rejects_bad_parameters() {
    let cases: Vec<(Params, AjoError)> = vec![
        (Params { name: String::new(), ..Params::default() }, AjoError::BadName),
        (Params { name: "x".repeat(33), ..Params::default() }, AjoError::BadName),
        (Params { contribution: 0, ..Params::default() }, AjoError::ZeroContribution),
        (Params { capacity: 1, ..Params::default() }, AjoError::BadCapacity),
        (Params { capacity: 13, ..Params::default() }, AjoError::BadCapacity),
        (Params { round_secs: 59, ..Params::default() }, AjoError::BadRoundLength),
        (Params { round_secs: 500 * DAY, ..Params::default() }, AjoError::BadRoundLength),
        (Params { grace_secs: -1, ..Params::default() }, AjoError::BadGrace),
        (Params { grace_secs: WEEK + 1, ..Params::default() }, AjoError::BadGrace),
        (Params { late_fee: CONTRIBUTION + 1, ..Params::default() }, AjoError::LateFeeTooHigh),
    ];
    for (p, err) in cases {
        let mut fx = Fx::new(TOKEN_PROGRAM, 1);
        assert_err(fx.create(p), err);
    }
}

#[test]
fn create_sets_up_circle_and_vault() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 1);
    fx.create(Params::default()).unwrap();
    let c = fx.state();
    assert_eq!(c.creator, fx.people[0].kp.pubkey());
    assert_eq!(c.members, vec![fx.people[0].kp.pubkey()]);
    assert_eq!(c.state, CircleState::Forming);
    assert_eq!(c.vault, fx.vault);
    assert_eq!(c.mint, fx.mint);
    assert_eq!(c.name, "Mama Ada's circle");
    let vault = fx.svm.get_account(&fx.vault).unwrap();
    assert_eq!(vault.owner, TOKEN_PROGRAM);
    // The vault's token owner is the circle PDA.
    assert_eq!(&vault.data[32..64], fx.circle.as_ref());
    // The same id cannot be reused.
    assert!(fx.create(Params::default()).is_err());
}

#[test]
fn create_rejects_mint_from_another_token_program() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 1);
    fx.tp = TOKEN_2022_PROGRAM; // mint is owned by classic Token
    // Rejected either by our MintOwner check or by the token program itself.
    assert!(fx.create(Params::default()).is_err());
    assert!(fx.svm.get_account(&fx.circle).map_or(true, |a| a.lamports == 0));
}

// ---------------------------------------------------------------------------
// join / start
// ---------------------------------------------------------------------------

#[test]
fn join_rules() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 4);
    fx.create(Params { capacity: 3, ..Params::default() }).unwrap();
    assert_err(fx.join(0), AjoError::AlreadyMember);
    fx.join(1).unwrap();
    assert_err(fx.join(1), AjoError::AlreadyMember);
    fx.join(2).unwrap();
    assert_err(fx.join(3), AjoError::CircleFull);
    fx.start().unwrap();
    assert_err(fx.join(3), AjoError::NotForming);
}

#[test]
fn start_rules() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 3);
    fx.create(Params::default()).unwrap();
    assert_err(fx.start(), AjoError::NotEnoughMembers);
    fx.join(1).unwrap();
    assert_err(fx.start_by(1), AjoError::NotCreator);
    // Starting with 2 of a possible 3 is allowed.
    fx.start().unwrap();
    assert_eq!(fx.state().members.len(), 2);
    assert_err(fx.start(), AjoError::NotForming);
}

// ---------------------------------------------------------------------------
// contribute
// ---------------------------------------------------------------------------

#[test]
fn contribute_rules() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 3);
    fx.create(Params::default()).unwrap();
    fx.join(1).unwrap();
    assert_err(fx.contribute(0), AjoError::NotActive);
    fx.start().unwrap();

    // Outsider (person 2 never joined).
    assert_err(fx.contribute(2), AjoError::NotMember);

    fx.contribute(0).unwrap();
    assert_err(fx.contribute(0), AjoError::AlreadyPaid);
    assert_eq!(fx.balance(0), START_BALANCE - CONTRIBUTION);

    // Paying from someone else's token account fails (token authority check).
    let other = fx.people[0].token;
    let vault = fx.vault;
    assert!(fx.contribute_from(1, other, vault).is_err());

    // A vault that is not the circle's is rejected.
    let fake_vault = set_token_account(&mut fx.svm, TOKEN_PROGRAM, fx.mint, fx.circle, 0);
    let mine = fx.people[1].token;
    assert!(fx.contribute_from(1, mine, fake_vault).is_err());
    assert_eq!(fx.balance(1), START_BALANCE);
}

#[test]
fn late_payment_adds_the_fee_to_the_pot() {
    let mut fx = Fx::running(TOKEN_PROGRAM, 3);
    fx.contribute(0).unwrap();
    fx.contribute(1).unwrap();
    fx.time(NOW + WEEK + 1); // just past due, inside grace
    fx.contribute(2).unwrap();
    assert_eq!(fx.balance(2), START_BALANCE - CONTRIBUTION - LATE_FEE);
    let r = fx.recipient();
    let before = fx.balance(r);
    fx.payout().unwrap();
    assert_eq!(fx.balance(r), before + 3 * CONTRIBUTION + LATE_FEE);
}

// ---------------------------------------------------------------------------
// payout
// ---------------------------------------------------------------------------

#[test]
fn payout_waits_for_everyone_until_grace_ends() {
    let mut fx = Fx::running(TOKEN_PROGRAM, 3);
    fx.contribute(0).unwrap();
    fx.contribute(1).unwrap();
    assert_err(fx.payout(), AjoError::RoundNotReady);
    fx.time(NOW + WEEK + 2 * DAY); // exactly at the end of grace: still waiting
    assert_err(fx.payout(), AjoError::RoundNotReady);
    fx.time(NOW + WEEK + 2 * DAY + 1);
    let r = fx.recipient();
    let before = fx.balance(r);
    fx.payout().unwrap();
    assert_eq!(fx.balance(r), before + 2 * CONTRIBUTION);

    let c = fx.state();
    assert_eq!(c.round, 1);
    assert_eq!(c.paid_mask, 0);
    assert_eq!(c.missed, vec![0, 0, 1], "member 2 missed round 0");
}

#[test]
fn payout_only_goes_to_the_rounds_member() {
    let mut fx = Fx::running(TOKEN_PROGRAM, 3);
    for i in 0..3 {
        fx.contribute(i).unwrap();
    }
    let r = fx.recipient();
    let wrong = (r + 1) % 3;
    let cranker = fx.people[wrong].kp.insecure_clone();

    // Someone else's account.
    assert_err(fx.payout_to(&cranker, fx.people[wrong].token), AjoError::WrongRecipient);

    // A fresh token account owned by the cranker.
    let own = set_token_account(&mut fx.svm, TOKEN_PROGRAM, fx.mint, cranker.pubkey(), 0);
    assert_err(fx.payout_to(&cranker, own), AjoError::WrongRecipient);

    // A token account of the right owner but another mint.
    let other_mint = Pubkey::new_unique();
    set_account(&mut fx.svm, other_mint, TOKEN_PROGRAM, mint_bytes(6));
    let wrong_mint =
        set_token_account(&mut fx.svm, TOKEN_PROGRAM, other_mint, fx.people[r].kp.pubkey(), 0);
    assert!(fx.payout_to(&cranker, wrong_mint).is_err());

    // Any account the recipient owns works, even when a stranger cranks it.
    let alt = set_token_account(&mut fx.svm, TOKEN_PROGRAM, fx.mint, fx.people[r].kp.pubkey(), 0);
    fx.payout_to(&cranker, alt).unwrap();
    assert_eq!(token_balance(&fx.svm, &alt), 3 * CONTRIBUTION);
}

#[test]
fn nobody_paid_round_still_advances_after_grace() {
    let mut fx = Fx::running(TOKEN_PROGRAM, 2);
    fx.time(NOW + WEEK + 2 * DAY + 1);
    fx.payout().unwrap();
    let c = fx.state();
    assert_eq!(c.round, 1);
    assert_eq!(c.missed, vec![1, 1]);
    assert_eq!(c.total_paid_out, 0);
}

// ---------------------------------------------------------------------------
// close_circle
// ---------------------------------------------------------------------------

#[test]
fn close_rules() {
    let mut fx = Fx::new(TOKEN_PROGRAM, 2);
    fx.create(Params::default()).unwrap();
    fx.join(1).unwrap();
    assert_err(fx.close_by(1), AjoError::NotCreator);
    fx.start().unwrap();
    assert_err(fx.close_by(0), AjoError::CannotClose);

    // A forming circle can be cancelled.
    let mut fx = Fx::new(TOKEN_PROGRAM, 2);
    fx.create(Params::default()).unwrap();
    fx.join(1).unwrap();
    fx.close_by(0).unwrap();
    assert!(fx.svm.get_account(&fx.circle).map_or(true, |a| a.lamports == 0));
}
