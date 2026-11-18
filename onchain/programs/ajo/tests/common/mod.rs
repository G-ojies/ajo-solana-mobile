//! Shared helpers: raw SPL token accounts, a transaction sender and a circle
//! fixture over LiteSVM. No network.

#![allow(dead_code)]

use {
    ajo::{AjoError, Circle, CIRCLE_SEED, VAULT_SEED},
    anchor_lang::{
        solana_program::instruction::Instruction,
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_pubkey::Pubkey,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

pub const NOW: i64 = 1_800_000_000;
pub const WEEK: i64 = 7 * 86_400;
pub const DAY: i64 = 86_400;
pub const USDC: u64 = 1_000_000;
pub const CONTRIBUTION: u64 = 10 * USDC;
pub const LATE_FEE: u64 = USDC;
pub const START_BALANCE: u64 = 1_000 * USDC;

pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;

pub fn system_program() -> Pubkey {
    Pubkey::default()
}

pub fn set_account(svm: &mut LiteSVM, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(key, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
        .unwrap();
}

pub fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; MINT_LEN];
    d[36..44].copy_from_slice(&u64::MAX.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

pub fn token_account_bytes(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    d
}

pub fn token_balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let acct = svm.get_account(key).expect("token account");
    u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
}

pub fn set_token_account(svm: &mut LiteSVM, tp: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
    let key = Pubkey::new_unique();
    set_account(svm, key, tp, token_account_bytes(mint, owner, amount));
    key
}

pub fn load_program() -> (LiteSVM, Pubkey) {
    let program_id = ajo::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../../../../target/deploy/ajo.so");
    svm.add_program(program_id, bytes).unwrap();
    (svm, program_id)
}

pub fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

pub fn fund(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    kp
}

pub fn send(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| e.to_string())?;
    match svm.send_transaction(tx) {
        Ok(meta) => {
            if std::env::var_os("AJO_CU").is_some() {
                eprintln!("compute units: {}", meta.compute_units_consumed);
            }
            Ok(())
        }
        Err(e) => Err(format!("{:?} | {}", e.err, e.meta.logs.join(" / "))),
    }
}

pub fn assert_err(res: Result<(), String>, err: AjoError) {
    let code = u32::from(err);
    match res {
        Ok(()) => panic!("expected {err:?} ({code}) but the transaction succeeded"),
        Err(e) => assert!(e.contains(&format!("Custom({code})")), "expected {err:?} ({code}), got: {e}"),
    }
}

pub fn read<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acct = svm.get_account(key).expect("account");
    T::try_deserialize(&mut &acct.data[..]).unwrap()
}

pub fn circle_pda(pid: &Pubkey, creator: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[CIRCLE_SEED, creator.as_ref(), &id.to_le_bytes()], pid).0
}

pub fn vault_pda(pid: &Pubkey, circle: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, circle.as_ref()], pid).0
}

pub struct Params {
    pub name: String,
    pub contribution: u64,
    pub capacity: u8,
    pub round_secs: i64,
    pub grace_secs: i64,
    pub late_fee: u64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            name: "Mama Ada's circle".into(),
            contribution: CONTRIBUTION,
            capacity: 3,
            round_secs: WEEK,
            grace_secs: 2 * DAY,
            late_fee: LATE_FEE,
        }
    }
}

pub struct Member {
    pub kp: Keypair,
    pub token: Pubkey,
}

/// A program, a mint, a creator and some would-be members with funded token accounts.
pub struct Fx {
    pub svm: LiteSVM,
    pub pid: Pubkey,
    pub tp: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub circle: Pubkey,
    pub vault: Pubkey,
    /// people[0] is the creator.
    pub people: Vec<Member>,
}

impl Fx {
    pub fn new(tp: Pubkey, people: usize) -> Self {
        let (mut svm, pid) = load_program();
        set_time(&mut svm, NOW);
        let mint = Pubkey::new_unique();
        set_account(&mut svm, mint, tp, mint_bytes(6));
        let people = (0..people)
            .map(|_| {
                let kp = fund(&mut svm);
                let token = set_token_account(&mut svm, tp, mint, kp.pubkey(), START_BALANCE);
                Member { kp, token }
            })
            .collect::<Vec<_>>();
        let id = 7;
        let circle = circle_pda(&pid, &people[0].kp.pubkey(), id);
        let vault = vault_pda(&pid, &circle);
        Fx { svm, pid, tp, mint, id, circle, vault, people }
    }

    pub fn time(&mut self, t: i64) {
        set_time(&mut self.svm, t);
    }

    pub fn state(&self) -> Circle {
        read(&self.svm, &self.circle)
    }

    pub fn create(&mut self, p: Params) -> Result<(), String> {
        let creator = self.people[0].kp.pubkey();
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::CreateCircle {
                creator,
                mint: self.mint,
                circle: self.circle,
                vault: self.vault,
                token_program: self.tp,
                system_program: system_program(),
            }
            .to_account_metas(None),
            data: ajo::instruction::CreateCircle {
                circle_id: self.id,
                name: p.name,
                contribution: p.contribution,
                capacity: p.capacity,
                round_secs: p.round_secs,
                grace_secs: p.grace_secs,
                late_fee: p.late_fee,
            }
            .data(),
        };
        send(&mut self.svm, ix, &[&self.people[0].kp])
    }

    pub fn join(&mut self, who: usize) -> Result<(), String> {
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::Join { member: self.people[who].kp.pubkey(), circle: self.circle }
                .to_account_metas(None),
            data: ajo::instruction::Join {}.data(),
        };
        send(&mut self.svm, ix, &[&self.people[who].kp])
    }

    pub fn start_by(&mut self, who: usize) -> Result<(), String> {
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::Start { creator: self.people[who].kp.pubkey(), circle: self.circle }
                .to_account_metas(None),
            data: ajo::instruction::Start {}.data(),
        };
        send(&mut self.svm, ix, &[&self.people[who].kp])
    }

    pub fn start(&mut self) -> Result<(), String> {
        self.start_by(0)
    }

    pub fn contribute_from(&mut self, who: usize, token: Pubkey, vault: Pubkey) -> Result<(), String> {
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::Contribute {
                member: self.people[who].kp.pubkey(),
                circle: self.circle,
                mint: self.mint,
                member_token: token,
                vault,
                token_program: self.tp,
            }
            .to_account_metas(None),
            data: ajo::instruction::Contribute {}.data(),
        };
        send(&mut self.svm, ix, &[&self.people[who].kp])
    }

    pub fn contribute(&mut self, who: usize) -> Result<(), String> {
        let token = self.people[who].token;
        let vault = self.vault;
        self.contribute_from(who, token, vault)
    }

    pub fn payout_to(&mut self, cranker: &Keypair, recipient_token: Pubkey) -> Result<(), String> {
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::Payout {
                cranker: cranker.pubkey(),
                circle: self.circle,
                mint: self.mint,
                vault: self.vault,
                recipient_token,
                token_program: self.tp,
            }
            .to_account_metas(None),
            data: ajo::instruction::Payout {}.data(),
        };
        send(&mut self.svm, ix, &[cranker])
    }

    /// Index into `people` of who collects the current round.
    pub fn recipient(&self) -> usize {
        let c = self.state();
        let key = c.current_recipient();
        self.people.iter().position(|m| m.kp.pubkey() == key).expect("recipient is a person")
    }

    /// Payout cranked by an outsider, to the right recipient.
    pub fn payout(&mut self) -> Result<(), String> {
        let outsider = fund(&mut self.svm);
        let token = self.people[self.recipient()].token;
        self.payout_to(&outsider, token)
    }

    pub fn close_by(&mut self, who: usize) -> Result<(), String> {
        let ix = Instruction {
            program_id: self.pid,
            accounts: ajo::accounts::CloseCircle {
                creator: self.people[who].kp.pubkey(),
                circle: self.circle,
                vault: self.vault,
                token_program: self.tp,
            }
            .to_account_metas(None),
            data: ajo::instruction::CloseCircle {}.data(),
        };
        send(&mut self.svm, ix, &[&self.people[who].kp])
    }

    /// Create a circle of `n` people (capacity `n`), everyone joins, started.
    pub fn running(tp: Pubkey, n: usize) -> Self {
        let mut fx = Fx::new(tp, n + 1); // one extra person who never joins
        fx.create(Params { capacity: n as u8, ..Params::default() }).unwrap();
        for i in 1..n {
            fx.join(i).unwrap();
        }
        fx.start().unwrap();
        fx
    }

    pub fn balance(&self, who: usize) -> u64 {
        token_balance(&self.svm, &self.people[who].token)
    }
}
