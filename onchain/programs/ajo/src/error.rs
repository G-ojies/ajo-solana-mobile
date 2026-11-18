use anchor_lang::prelude::*;

#[error_code]
pub enum AjoError {
    #[msg("Name must be 1 to 32 bytes")]
    BadName,
    #[msg("Contribution must be greater than zero")]
    ZeroContribution,
    #[msg("A circle holds 2 to 12 members")]
    BadCapacity,
    #[msg("Round length must be between one minute and about a year")]
    BadRoundLength,
    #[msg("Grace period must be between zero and one round")]
    BadGrace,
    #[msg("Late fee cannot be more than the contribution")]
    LateFeeTooHigh,
    #[msg("The circle is not taking members")]
    NotForming,
    #[msg("The circle is full")]
    CircleFull,
    #[msg("Already a member")]
    AlreadyMember,
    #[msg("Only the creator can do this")]
    NotCreator,
    #[msg("A circle needs at least 2 members to start")]
    NotEnoughMembers,
    #[msg("The circle is not running")]
    NotActive,
    #[msg("Not a member of this circle")]
    NotMember,
    #[msg("Already paid this round")]
    AlreadyPaid,
    #[msg("The vault received a different amount than was sent (fee-on-transfer mints are not supported)")]
    AmountMismatch,
    #[msg("Not everyone has paid and the grace period has not ended")]
    RoundNotReady,
    #[msg("The token account does not belong to this round's recipient")]
    WrongRecipient,
    #[msg("Only a forming or finished circle can be closed")]
    CannotClose,
    #[msg("The vault still holds funds")]
    VaultNotEmpty,
    #[msg("The mint is not owned by the given token program")]
    MintOwner,
    #[msg("Arithmetic overflow")]
    Overflow,
}
