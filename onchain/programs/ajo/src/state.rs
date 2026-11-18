use anchor_lang::prelude::*;

pub const CIRCLE_SEED: &[u8] = b"circle";
pub const VAULT_SEED: &[u8] = b"vault";

/// Most members a circle can hold. The paid flags are a `u16`, so this must stay at or below 16.
pub const MAX_MEMBERS: usize = 12;
pub const MIN_MEMBERS: usize = 2;
pub const MAX_NAME_LEN: usize = 32;

/// Shortest round, one minute, so a whole circle can be demoed live.
pub const MIN_ROUND_SECS: i64 = 60;
/// Longest round, a little over a year.
pub const MAX_ROUND_SECS: i64 = 400 * 24 * 60 * 60;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CircleState {
    /// Taking members. Nothing is held yet.
    Forming,
    /// Rounds are running: members pay in, the pot goes to one member per round.
    Active,
    /// Every member has had a turn.
    Done,
}

/// One rotating savings circle. Every member pays `contribution` each round and
/// the whole pot goes to one member per round, in `order`, until all have collected.
#[account]
#[derive(InitSpace, Debug)]
pub struct Circle {
    /// Created the circle, is member 0, starts it and can close it when it is empty.
    pub creator: Pubkey,
    /// Any number the creator picks, so one wallet can run several circles.
    pub circle_id: u64,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    /// The token everyone pays in (USDC on mainnet, a test mint on devnet).
    pub mint: Pubkey,
    /// Token account owned by this circle that holds the pot between payouts.
    pub vault: Pubkey,
    pub token_program: Pubkey,
    /// Amount each member pays per round, in the mint's base units.
    pub contribution: u64,
    /// Added on top of `contribution` when a member pays after the round is due.
    pub late_fee: u64,
    /// Length of one round in seconds. Round r is due at `start_ts + (r + 1) * round_secs`.
    pub round_secs: i64,
    /// After the due time plus this grace, anyone may pay the round out even if
    /// some members have not paid, so one missing member cannot freeze the circle.
    pub grace_secs: i64,
    /// Member cap chosen at creation (2 to 12).
    pub capacity: u8,
    pub state: CircleState,
    pub created_ts: i64,
    /// Set by `start`.
    pub start_ts: i64,
    /// Current round, 0-based. Equals the member count once Done.
    pub round: u8,
    /// Bit i set = member i has paid this round.
    pub paid_mask: u16,
    #[max_len(MAX_MEMBERS)]
    pub members: Vec<Pubkey>,
    /// Payout order: `order[r]` is the index in `members` of who collects round r.
    #[max_len(MAX_MEMBERS)]
    pub order: Vec<u8>,
    /// Rounds each member failed to pay before the round was paid out. Public record.
    #[max_len(MAX_MEMBERS)]
    pub missed: Vec<u8>,
    /// Total paid out to members so far.
    pub total_paid_out: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Circle {
    pub fn member_index(&self, key: &Pubkey) -> Option<usize> {
        self.members.iter().position(|m| m == key)
    }

    /// Who collects the current round, or the default key when there is none.
    pub fn current_recipient(&self) -> Pubkey {
        self.order
            .get(self.round as usize)
            .and_then(|&i| self.members.get(i as usize))
            .copied()
            .unwrap_or_default()
    }

    pub fn all_paid(&self) -> bool {
        let n = self.members.len();
        n > 0 && self.paid_mask == ((1u32 << n) - 1) as u16
    }
}
