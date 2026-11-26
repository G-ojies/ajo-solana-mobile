//! Ajo: the rotating savings circle (ajo, esusu, susu) with the pot held by a
//! program instead of a person.
//!
//! Every member pays a fixed amount each round. When everyone has paid, anyone
//! can send the whole pot to that round's member. The payout order is drawn at
//! start from public data, so anyone can recompute it. There is no admin key,
//! no fee and no way for the creator to touch the pot.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub mod error;
pub mod state;
#[cfg(kani)]
mod proofs;

pub use error::AjoError;
pub use state::*;

declare_id!("66oEASieGnPhV51Xi1TVWFhotG3TfjpBYXHVUPpVXF7b");

// ---------------------------------------------------------------------------
// Pure logic, free of accounts so it can be tested on the host.
// ---------------------------------------------------------------------------

/// Deterministic payout order: a Fisher-Yates shuffle of `0..n` driven by a
/// 64-bit FNV-1a hash of `seed`. `start` seeds it with the circle address and
/// every member key in join order, so anyone can recompute the order. It is
/// fair against a careless creator, not against members who grind keys.
pub fn draw_order(seed: &[u8], n: usize) -> Vec<u8> {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let mut state = h | 1;
    let mut next = || {
        // xorshift64*
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    shuffle(n, next)
}

/// Fisher-Yates shuffle of `0..n`, driven by any source of random words.
pub fn shuffle(n: usize, mut next: impl FnMut() -> u64) -> Vec<u8> {
    let mut order: Vec<u8> = (0..n as u8).collect();
    for i in (1..n).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        order.swap(i, j);
    }
    order
}

/// When round `round` is due.
pub fn round_due(start_ts: i64, round: u8, round_secs: i64) -> Option<i64> {
    round_secs
        .checked_mul(round as i64 + 1)
        .and_then(|d| start_ts.checked_add(d))
}

/// What a member owes for a round paid at `now`: the contribution, plus the
/// late fee once the round is past due. Returns (amount, late).
pub fn amount_owed(now: i64, due: i64, contribution: u64, late_fee: u64) -> Option<(u64, bool)> {
    if now > due {
        contribution.checked_add(late_fee).map(|a| (a, true))
    } else {
        Some((contribution, false))
    }
}

// ---------------------------------------------------------------------------
// Events: the app builds each circle's history from these.
// ---------------------------------------------------------------------------

#[event]
pub struct CircleCreated {
    pub circle: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub contribution: u64,
    pub capacity: u8,
}

#[event]
pub struct MemberJoined {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub index: u8,
}

#[event]
pub struct CircleStarted {
    pub circle: Pubkey,
    pub start_ts: i64,
    pub order: Vec<u8>,
}

#[event]
pub struct Contributed {
    pub circle: Pubkey,
    pub member: Pubkey,
    pub round: u8,
    pub amount: u64,
    pub late: bool,
}

#[event]
pub struct PaidOut {
    pub circle: Pubkey,
    pub round: u8,
    pub recipient: Pubkey,
    pub amount: u64,
    /// Bit i set = member i had not paid when the round was paid out.
    pub missed_mask: u16,
}

#[event]
pub struct CircleClosed {
    pub circle: Pubkey,
}

#[program]
pub mod ajo {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn create_circle(
        ctx: Context<CreateCircle>,
        circle_id: u64,
        name: String,
        contribution: u64,
        capacity: u8,
        round_secs: i64,
        grace_secs: i64,
        late_fee: u64,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, AjoError::BadName);
        require!(contribution > 0, AjoError::ZeroContribution);
        require!(
            (MIN_MEMBERS..=MAX_MEMBERS).contains(&(capacity as usize)),
            AjoError::BadCapacity
        );
        require!(
            (MIN_ROUND_SECS..=MAX_ROUND_SECS).contains(&round_secs),
            AjoError::BadRoundLength
        );
        require!((0..=round_secs).contains(&grace_secs), AjoError::BadGrace);
        require!(late_fee <= contribution, AjoError::LateFeeTooHigh);

        let creator = ctx.accounts.creator.key();
        let circle = &mut ctx.accounts.circle;
        circle.creator = creator;
        circle.circle_id = circle_id;
        circle.name = name;
        circle.mint = ctx.accounts.mint.key();
        circle.vault = ctx.accounts.vault.key();
        circle.token_program = ctx.accounts.token_program.key();
        circle.contribution = contribution;
        circle.late_fee = late_fee;
        circle.round_secs = round_secs;
        circle.grace_secs = grace_secs;
        circle.capacity = capacity;
        circle.state = CircleState::Forming;
        circle.created_ts = Clock::get()?.unix_timestamp;
        circle.start_ts = 0;
        circle.round = 0;
        circle.paid_mask = 0;
        circle.members = vec![creator];
        circle.order = Vec::new();
        circle.missed = vec![0];
        circle.total_paid_out = 0;
        circle.bump = ctx.bumps.circle;
        circle.vault_bump = ctx.bumps.vault;

        emit!(CircleCreated {
            circle: circle.key(),
            creator,
            mint: circle.mint,
            contribution,
            capacity,
        });
        emit!(MemberJoined { circle: circle.key(), member: creator, index: 0 });
        Ok(())
    }

    pub fn join(ctx: Context<Join>) -> Result<()> {
        let member = ctx.accounts.member.key();
        let circle = &mut ctx.accounts.circle;
        require!(circle.state == CircleState::Forming, AjoError::NotForming);
        require!(circle.member_index(&member).is_none(), AjoError::AlreadyMember);
        require!(circle.members.len() < circle.capacity as usize, AjoError::CircleFull);

        circle.members.push(member);
        circle.missed.push(0);
        emit!(MemberJoined {
            circle: circle.key(),
            member,
            index: (circle.members.len() - 1) as u8,
        });
        Ok(())
    }

    /// Creator only. Starts round 0 now and draws the payout order. A circle
    /// may start before it is full; the members present are the circle.
    pub fn start(ctx: Context<Start>) -> Result<()> {
        let key = ctx.accounts.circle.key();
        let circle = &mut ctx.accounts.circle;
        require!(circle.state == CircleState::Forming, AjoError::NotForming);
        let n = circle.members.len();
        require!(n >= MIN_MEMBERS, AjoError::NotEnoughMembers);

        let mut seed = Vec::with_capacity(32 * (n + 1));
        seed.extend_from_slice(key.as_ref());
        for m in &circle.members {
            seed.extend_from_slice(m.as_ref());
        }
        circle.order = draw_order(&seed, n);
        circle.start_ts = Clock::get()?.unix_timestamp;
        circle.state = CircleState::Active;
        circle.round = 0;
        circle.paid_mask = 0;

        emit!(CircleStarted { circle: key, start_ts: circle.start_ts, order: circle.order.clone() });
        Ok(())
    }

    /// A member pays this round's contribution (plus the late fee if past due)
    /// straight into the circle's vault.
    pub fn contribute(ctx: Context<Contribute>) -> Result<()> {
        let member = ctx.accounts.member.key();
        let circle = &ctx.accounts.circle;
        require!(circle.state == CircleState::Active, AjoError::NotActive);
        let idx = circle.member_index(&member).ok_or(AjoError::NotMember)?;
        require!(circle.paid_mask & (1 << idx) == 0, AjoError::AlreadyPaid);

        let now = Clock::get()?.unix_timestamp;
        let due = round_due(circle.start_ts, circle.round, circle.round_secs)
            .ok_or(AjoError::Overflow)?;
        let (amount, late) = amount_owed(now, due, circle.contribution, circle.late_fee)
            .ok_or(AjoError::Overflow)?;

        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.member_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.member.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(AjoError::Overflow)?;
        require!(received == amount, AjoError::AmountMismatch);

        let circle = &mut ctx.accounts.circle;
        circle.paid_mask |= 1 << idx;
        emit!(Contributed { circle: circle.key(), member, round: circle.round, amount, late });
        Ok(())
    }

    /// Anyone. Sends the whole vault to this round's member once everyone has
    /// paid, or once the round is past due plus grace. Unpaid members are
    /// recorded in `missed`. Then the next round begins.
    pub fn payout(ctx: Context<Payout>) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(circle.state == CircleState::Active, AjoError::NotActive);
        let n = circle.members.len();
        if !circle.all_paid() {
            let now = Clock::get()?.unix_timestamp;
            let closes = round_due(circle.start_ts, circle.round, circle.round_secs)
                .and_then(|d| d.checked_add(circle.grace_secs))
                .ok_or(AjoError::Overflow)?;
            require!(now > closes, AjoError::RoundNotReady);
        }

        let amount = ctx.accounts.vault.amount;
        if amount > 0 {
            let creator = circle.creator;
            let id_bytes = circle.circle_id.to_le_bytes();
            let seeds: &[&[u8]] = &[CIRCLE_SEED, creator.as_ref(), &id_bytes, &[circle.bump]];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.recipient_token.to_account_info(),
                        authority: ctx.accounts.circle.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        let key = ctx.accounts.circle.key();
        let circle = &mut ctx.accounts.circle;
        let full = ((1u32 << n) - 1) as u16;
        let missed_mask = !circle.paid_mask & full;
        for i in 0..n {
            if missed_mask & (1 << i) != 0 {
                circle.missed[i] = circle.missed[i].saturating_add(1);
            }
        }
        let recipient = circle.current_recipient();
        let round = circle.round;
        circle.total_paid_out = circle.total_paid_out.checked_add(amount).ok_or(AjoError::Overflow)?;
        circle.round = circle.round.checked_add(1).ok_or(AjoError::Overflow)?;
        circle.paid_mask = 0;
        if circle.round as usize >= n {
            circle.state = CircleState::Done;
        }

        emit!(PaidOut { circle: key, round, recipient, amount, missed_mask });
        Ok(())
    }

    /// Creator only, while forming (nobody has paid anything) or once done.
    /// Closes the empty vault and the circle and returns the rent.
    pub fn close_circle(ctx: Context<CloseCircle>) -> Result<()> {
        let circle = &ctx.accounts.circle;
        require!(
            matches!(circle.state, CircleState::Forming | CircleState::Done),
            AjoError::CannotClose
        );
        require!(ctx.accounts.vault.amount == 0, AjoError::VaultNotEmpty);

        let creator = circle.creator;
        let id_bytes = circle.circle_id.to_le_bytes();
        let seeds: &[&[u8]] = &[CIRCLE_SEED, creator.as_ref(), &id_bytes, &[circle.bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.circle.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(CircleClosed { circle: ctx.accounts.circle.key() });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(circle_id: u64)]
pub struct CreateCircle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        constraint = mint.to_account_info().owner == &token_program.key() @ AjoError::MintOwner,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + Circle::INIT_SPACE,
        seeds = [CIRCLE_SEED, creator.key().as_ref(), &circle_id.to_le_bytes()],
        bump,
    )]
    pub circle: Box<Account<'info, Circle>>,

    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, circle.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = circle,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    pub member: Signer<'info>,
    #[account(mut)]
    pub circle: Box<Account<'info, Circle>>,
}

#[derive(Accounts)]
pub struct Start<'info> {
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ AjoError::NotCreator)]
    pub circle: Box<Account<'info, Circle>>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    pub member: Signer<'info>,

    #[account(
        mut,
        has_one = mint,
        has_one = vault,
        has_one = token_program,
    )]
    pub circle: Box<Account<'info, Circle>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = member,
        token::token_program = token_program,
    )]
    pub member_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    /// Anyone may trigger a payout; the money can only go to the round's member.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        has_one = mint,
        has_one = vault,
        has_one = token_program,
    )]
    pub circle: Box<Account<'info, Circle>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = recipient_token.owner == circle.current_recipient() @ AjoError::WrongRecipient,
    )]
    pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseCircle<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        close = creator,
        has_one = creator @ AjoError::NotCreator,
        has_one = vault,
        has_one = token_program,
    )]
    pub circle: Box<Account<'info, Circle>>,

    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
