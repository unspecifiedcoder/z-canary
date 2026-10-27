use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine as _;
use http::Uri;
use pepper_sync::wallet::{
    IronwoodNote, NoteInterface, OrchardNote, OutputId, SaplingNote, WalletTransaction,
};
use sha2::{Digest, Sha256};
use zcanary_core::{Operation, decode_and_verify_memo};
use zcash_address::ZcashAddress;
use zcash_client_backend::zip321::{Payment, TransactionRequest};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::block::{BlockHash, BlockHeader};
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zeroize::Zeroize;
use zingo_netutils::lightwallet_protocol::{BlockId, BlockRange, CompactBlock};
use zingo_netutils::time::{FINITE_STREAM_TIMEOUT, STREAM_MSG_TIMEOUT};
use zingo_netutils::{GrpcIndexer, Indexer as _};
use zingolib::config::{ChainType, ClientConfig, WalletConfig, lib_birthday};
use zingolib::lightclient::{DEFAULT_REQUEST_TIMEOUT, LightClient};
use zingolib::wallet::WalletSettings;
use zingolib::wallet::keys::unified::{ReceiverSelection, encode_ufvk};
use zip32::AccountId;

const TESTNET: ChainType = ChainType::Testnet;
const TESTNET_INDEXER: &str = "https://testnet.zec.rocks:443";
const TESTNET_CHAIN_NAME: &str = "test";
const COMMAND_ARGUMENT_OFFSET: usize = 1;
const STATE_DIRECTORY: &str = "state";
const RECOVERY_FILE: &str = "recovery.dpapi";
const SEND_STATE_FILE: &str = "send-state.txt";
const SENDER_WALLET_NAME: &str = "sender-wallet.dat";
const RECEIVER_WALLET_NAME: &str = "receiver-wallet.dat";
const VIEWER_WALLET_NAME: &str = "viewer-wallet.dat";
const ACCOUNT_COUNT: u32 = 1;
const MEMO_PREFIX: u8 = 0xff;
const MEMO_PREFIX_INDEX: usize = 0;
const MEMO_PREFIX_LEN: usize = 1;
const MEMO_WIRE_LEN: usize = 512;
const SEND_AMOUNT_ZATOSHI: u64 = 10_000;
const MIN_SEND_FEE_RESERVE_ZATOSHI: u64 = 10_000;
const BIRTHDAY_TIP_MARGIN: u32 = 10;
const NEW_SEED_CHAIN_HEIGHT_MARGIN: u32 = 100;
const SCAN_ATTEMPTS: usize = 20;
const SCAN_RETRY_DELAY: Duration = Duration::from_secs(15);
const FUNDING_RETRY_DELAY: Duration = Duration::from_secs(30);
const FIRST_ATTEMPT_INDEX: usize = 0;
const ATTEMPT_ORDINAL_OFFSET: usize = 1;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .thread_stack_size(67_108_864)
        .enable_all()
        .build()
        .context("build large-stack Tokio runtime")?
        .block_on(run())
}

async fn run() -> Result<()> {
    let mut arguments = std::env::args().skip(COMMAND_ARGUMENT_OFFSET);
    let mode = arguments.next().context("usage: wallet-gate prepare|live-proof|live-command MEMO_HEX_FILE|recover-proof|export-viewer OUTPUT_PATH|scan-batch VIEWER_DPAPI START_HEIGHT EXPECTED_PREV_HASH CONFIRMATIONS|checkpoint CONFIRMATIONS|status|estimate-command")?;
    let command_path = if mode == "live-command" {
        Some(PathBuf::from(
            arguments
                .next()
                .context("usage: wallet-gate live-command MEMO_HEX_FILE")?,
        ))
    } else {
        None
    };
    let scan_args = if mode == "scan-batch" {
        Some(ScanBatchArgs {
            viewer_path: PathBuf::from(arguments.next().context("missing VIEWER_DPAPI path")?),
            start_height: arguments
                .next()
                .context("missing START_HEIGHT")?
                .parse()
                .context("invalid START_HEIGHT")?,
            expected_prev_hash: arguments.next().context("missing EXPECTED_PREV_HASH")?,
            confirmations: arguments
                .next()
                .context("missing CONFIRMATIONS")?
                .parse()
                .context("invalid CONFIRMATIONS")?,
        })
    } else {
        None
    };
    let export_args = if mode == "export-viewer" {
        Some(PathBuf::from(
            arguments.next().context("missing OUTPUT_PATH")?,
        ))
    } else {
        None
    };
    let checkpoint_confirmations = if mode == "checkpoint" {
        Some(
            arguments
                .next()
                .context("missing CONFIRMATIONS")?
                .parse()
                .context("invalid CONFIRMATIONS")?,
        )
    } else {
        None
    };
    ensure!(
        arguments.next().is_none(),
        "invalid arguments; see prepare, live-proof, live-command, recover-proof, export-viewer, or scan-batch usage"
    );
    ensure!(
        mode == "prepare"
            || mode == "live-proof"
            || mode == "live-command"
            || mode == "recover-proof"
            || mode == "export-viewer"
            || mode == "scan-batch"
            || mode == "checkpoint"
            || mode == "status"
            || mode == "estimate-command",
        "supported modes: prepare, live-proof, live-command, recover-proof, export-viewer, scan-batch, checkpoint, status, estimate-command"
    );

    let fixture = if mode == "live-proof" || mode == "recover-proof" {
        Some(memo_fixture()?)
    } else {
        None
    };
    let indexer_uri: Uri = TESTNET_INDEXER
        .parse()
        .context("parse pinned testnet indexer URI")?;
    if let Some(scan_args) = scan_args {
        return scan_batch(scan_args).await;
    }
    if let Some(confirmations) = checkpoint_confirmations {
        return emit_checkpoint(confirmations).await;
    }
    if mode == "status" {
        return emit_wallet_status(wallet_state_dir()?, indexer_uri).await;
    }
    if mode == "estimate-command" {
        return tokio::time::timeout(
            Duration::from_secs(90),
            emit_command_estimate(wallet_state_dir()?, indexer_uri),
        )
        .await
        .context("command fee estimation exceeded 90 seconds; no broadcast attempted")?;
    }

    let birthday = if mode == "export-viewer" {
        let _ = testnet_tip(&indexer_uri).await?;
        0
    } else {
        verify_testnet_indexer(indexer_uri.clone()).await?
    };

    let state_dir = wallet_state_dir()?;
    std::fs::create_dir_all(&state_dir).context("create persistent state directory")?;
    let recovery_path = state_dir.join(RECOVERY_FILE);
    let recovery = if recovery_path.exists() {
        load_recovery(&recovery_path)?
    } else {
        ensure!(mode == "prepare", "recovery is missing; run prepare first");
        ensure!(
            !state_dir.join(SEND_STATE_FILE).exists(),
            "send state exists but encrypted recovery is missing; refusing to create a new identity"
        );
        let recovery = create_recovery(indexer_uri.clone(), birthday).await?;
        let mut plaintext = encode_recovery(&recovery);
        let encrypted = dpapi("Protect", &plaintext)?;
        plaintext.zeroize();
        write_durable(&recovery_path, encrypted.as_bytes())?;
        load_recovery(&recovery_path)?
    };

    if let Some(viewer_path) = export_args {
        return export_viewer(&recovery, viewer_path, indexer_uri).await;
    }

    let mut sender = restore_wallet(
        indexer_uri.clone(),
        "sender",
        SENDER_WALLET_NAME,
        &recovery.sender_seed,
        recovery.birthday,
    )
    .await?;
    let sender_address = new_shielded_address(&mut sender).await?;
    ensure!(
        sender_address == recovery.sender_address,
        "restored sender address differs from encrypted recovery; refusing to continue"
    );
    let mut receiver = restore_wallet(
        indexer_uri.clone(),
        "receiver",
        RECEIVER_WALLET_NAME,
        &recovery.receiver_seed,
        recovery.birthday,
    )
    .await?;
    let receiver_address = new_shielded_address(&mut receiver).await?;
    ensure!(
        receiver_address == recovery.receiver_address,
        "restored receiver address differs from encrypted recovery"
    );
    let receiver_ufvk = wallet_ufvk(&receiver).await?;
    drop(receiver);
    if mode == "prepare" {
        println!("sender_testnet_address={sender_address}");
        println!("receiver_testnet_address={receiver_address}");
        println!("recovery_encrypted=true");
        println!("restore_verified=true");
        return Ok(());
    }

    let mut viewer = new_viewing_wallet(
        indexer_uri,
        state_dir.join("viewer"),
        receiver_ufvk,
        recovery.birthday,
    )
    .await?;
    let viewer_path = viewer.wallet_path();
    ensure!(
        !viewer_path.exists(),
        "view-only wallet file already exists"
    );
    ensure_viewing_only(&viewer).await?;

    if mode == "recover-proof" {
        let fixture = fixture.context("recovery memo fixture")?;
        let send_state = state_dir.join(SEND_STATE_FILE);
        ensure!(
            send_state.exists(),
            "send state is missing; there is no ambiguous proof to recover"
        );
        ensure!(
            std::fs::read_to_string(&send_state)?.trim() == "broadcast-unknown",
            "send state is not the expected ambiguous marker"
        );
        let (txid, evidence) = scan_exact_memo_any(&mut viewer, &fixture).await?;
        write_replace(&send_state, format!("txid={txid}\n").as_bytes())?;
        let event_path = state_dir.join("recovered-proof-event.json");
        let event = format!(
            "{{\"raw_memo_hex\":\"{}\",\"network\":\"testnet\",\"scanner\":\"ufvk-only\",\"txid\":\"{txid}\",\"block_height\":{},\"block_hash\":\"{}\",\"output_index\":{}}}\n",
            hex::encode(fixture),
            u32::from(evidence.height),
            evidence.block_hash,
            evidence.output_id.output_index()
        );
        if event_path.exists() {
            ensure!(
                std::fs::read_to_string(&event_path)? == event,
                "existing recovered proof event differs"
            );
        } else {
            write_durable(&event_path, event.as_bytes())?;
        }
        println!("proof_recovered=true");
        println!("txid={txid}");
        println!("block_height={}", u32::from(evidence.height));
        println!("block_hash={}", evidence.block_hash);
        println!("output_index={}", evidence.output_id.output_index());
        println!("recovery_event={}", event_path.display());
        return Ok(());
    }

    if let Some(command_path) = command_path {
        let (memo, command) = load_verified_command(&command_path)?;
        let memo_hex = hex::encode(memo);
        let memo_hash = hex::encode(Sha256::digest(memo));
        let command_dir = state_dir.join("commands").join(&memo_hash);
        std::fs::create_dir_all(&command_dir).context("create command journal directory")?;
        let memo_path = command_dir.join("memo.hex");
        if memo_path.exists() {
            ensure!(
                std::fs::read_to_string(&memo_path)?.trim() == memo_hex,
                "journal memo differs; refusing broadcast"
            );
        } else {
            write_durable(&memo_path, memo_hex.as_bytes())?;
        }
        let command_state = command_dir.join("send-state.txt");
        let txid = if command_state.exists() {
            let saved =
                std::fs::read_to_string(&command_state).context("read command journal state")?;
            let value = saved
                .strip_prefix("txid=")
                .context("command broadcast outcome is unknown; refusing duplicate send")?
                .trim();
            zcash_protocol::TxId::from_hex(value).context("parse journal txid")?
        } else {
            wait_for_spendable_funds(&mut sender).await?;
            prepare_memo_send(&mut sender, &receiver_address, memo).await?;
            write_durable(&command_state, b"broadcast-unknown\n")?;
            let txid = send_prepared_memo(&mut sender).await.map_err(|e| {
                anyhow::anyhow!(
                    "command broadcast may have succeeded; journal is fail-closed: {e:#}"
                )
            })?;
            write_replace(&command_state, format!("txid={txid}\n").as_bytes())?;
            txid
        };
        println!("operation={}", operation_name(command.operation));
        println!("sequence={}", command.sequence);
        println!("txid={txid}");
        let evidence = scan_exact_memo(&mut viewer, txid, &memo).await?;
        let tip_height =
            verify_testnet_indexer(TESTNET_INDEXER.parse()?).await? + BIRTHDAY_TIP_MARGIN;
        let block_height = u32::from(evidence.height);
        ensure!(
            tip_height >= block_height,
            "testnet tip is behind the confirmed memo block"
        );
        let confirmations = tip_height - block_height + 1;
        let event = format!(
            "{{\"raw_memo_hex\":\"{memo_hex}\",\"network\":\"testnet\",\"scanner\":\"ufvk-only\",\"operation\":\"{}\",\"sequence\":\"{}\",\"txid\":\"{txid}\",\"block_height\":{block_height},\"block_hash\":\"{}\",\"output_index\":{},\"confirmations\":{confirmations}}}\n",
            operation_name(command.operation),
            command.sequence,
            evidence.block_hash,
            evidence.output_id.output_index()
        );
        let event_path = command_dir.join("event.json");
        if event_path.exists() {
            let saved = std::fs::read_to_string(&event_path)?;
            ensure!(
                saved.contains(&format!("\"raw_memo_hex\":\"{memo_hex}\""))
                    && saved.contains(&format!("\"txid\":\"{txid}\"")),
                "existing command event does not match verified memo and transaction"
            );
        } else {
            write_durable(&event_path, event.as_bytes())?;
        }
        println!("block_height={}", u32::from(evidence.height));
        println!("block_hash={}", evidence.block_hash);
        println!("output_index={}", evidence.output_id.output_index());
        println!("confirmations={confirmations}");
        println!("confirmation_status=confirmed");
        println!("memo_match=true");
        println!("command_event={}", event_path.display());
        return Ok(());
    }

    println!("sender_testnet_address={sender_address}");
    println!("receiver_testnet_address={receiver_address}");
    println!("faucet=https://fauzec.com/");
    println!("alternate_faucet=https://faucet.testnet.valargroup.dev/");
    println!("sender_restore_verified=true");
    println!("Fund the sender address with testnet TAZ; this process polls automatically.");
    let send_state = state_dir.join(SEND_STATE_FILE);
    let txid = if send_state.exists() {
        let saved = std::fs::read_to_string(&send_state).context("read send state")?;
        let value = saved
            .strip_prefix("txid=")
            .context("previous broadcast has unknown outcome; refusing to duplicate it")?
            .trim();
        zcash_protocol::TxId::from_hex(value).context("parse persisted public transaction ID")?
    } else {
        wait_for_spendable_funds(&mut sender).await?;
        prepare_memo_send(
            &mut sender,
            &receiver_address,
            fixture.context("live-proof memo fixture")?,
        )
        .await?;
        write_durable(&send_state, b"broadcast-unknown\n")?;
        let txid = match send_prepared_memo(&mut sender).await {
            Ok(txid) => txid,
            Err(error) => bail!(
                "broadcast outcome may be ambiguous; state is fail-closed and no retry is allowed: {error:#}"
            ),
        };
        write_replace(&send_state, format!("txid={}\n", txid).as_bytes())?;
        txid
    };
    println!("txid={txid}");
    let fixture = fixture.context("live-proof memo fixture")?;
    let evidence = scan_exact_memo(&mut viewer, txid, &fixture).await?;
    println!("block_height={}", u32::from(evidence.height));
    println!("block_hash={}", evidence.block_hash);
    println!("output_index={}", evidence.output_id.output_index());
    println!("confirmation_status=confirmed");
    println!("memo_sha256={}", hex::encode(Sha256::digest(fixture)));
    println!("memo_match=true");

    Ok(())
}

struct Recovery {
    birthday: u32,
    sender_seed: String,
    sender_address: String,
    receiver_seed: String,
    receiver_address: String,
}
impl Drop for Recovery {
    fn drop(&mut self) {
        self.sender_seed.zeroize();
        self.receiver_seed.zeroize();
    }
}

struct ViewerRecovery {
    birthday: u32,
    ufvk: String,
    receiver_address: String,
}

impl Drop for ViewerRecovery {
    fn drop(&mut self) {
        self.ufvk.zeroize();
    }
}

struct ScanBatchArgs {
    viewer_path: PathBuf,
    start_height: u32,
    expected_prev_hash: String,
    confirmations: u32,
}

struct MemoEventOutput {
    output_index: u32,
    memo_hex: String,
}

const MAX_BATCH_BLOCKS: u32 = 128;

fn wallet_state_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ZCANARY_WALLET_STATE_DIR") {
        let path = PathBuf::from(path);
        ensure!(
            path.is_absolute(),
            "ZCANARY_WALLET_STATE_DIR must be an absolute path"
        );
        Ok(path)
    } else {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(STATE_DIRECTORY))
    }
}

fn decode_viewer_record(plaintext: &str) -> Result<ViewerRecovery> {
    let mut lines = plaintext.lines();
    let birthday = lines
        .next()
        .context("viewer record is missing birthday")?
        .parse()
        .context("viewer birthday is invalid")?;
    let ufvk = lines
        .next()
        .context("viewer record is missing UFVK")?
        .to_owned();
    let receiver_address = lines
        .next()
        .context("viewer record is missing public address")?
        .to_owned();
    ensure!(
        lines.next().is_none(),
        "viewer record contains unexpected fields"
    );
    ensure!(
        !ufvk.is_empty() && !receiver_address.is_empty(),
        "viewer record has empty fields"
    );
    Ok(ViewerRecovery {
        birthday,
        ufvk,
        receiver_address,
    })
}

fn load_viewer_record(path: &Path) -> Result<ViewerRecovery> {
    let encrypted = std::fs::read_to_string(path).context("read DPAPI viewer file")?;
    let mut plaintext = dpapi("Unprotect", &encrypted)?;
    let parsed = decode_viewer_record(&plaintext);
    plaintext.zeroize();
    parsed
}

async fn export_viewer(recovery: &Recovery, output_path: PathBuf, indexer_uri: Uri) -> Result<()> {
    ensure!(
        !output_path.exists(),
        "viewer DPAPI output already exists; refusing to overwrite it"
    );
    if let Some(parent) = output_path.parent() {
        ensure!(parent.exists(), "viewer output directory does not exist");
    }
    let mut receiver = restore_wallet(
        indexer_uri.clone(),
        "receiver",
        RECEIVER_WALLET_NAME,
        &recovery.receiver_seed,
        recovery.birthday,
    )
    .await?;
    let receiver_address = new_shielded_address(&mut receiver).await?;
    ensure!(
        receiver_address == recovery.receiver_address,
        "restored receiver address differs from recovery record"
    );
    let mut ufvk = wallet_ufvk(&receiver).await?;
    drop(receiver);
    let checkpoint = fetch_checkpoint(&indexer_uri, recovery.birthday).await?;
    let viewer = ViewerRecovery {
        birthday: recovery.birthday,
        ufvk: std::mem::take(&mut ufvk),
        receiver_address,
    };
    let mut plaintext = format!(
        "{}\n{}\n{}\n",
        viewer.birthday, viewer.ufvk, viewer.receiver_address
    );
    let encrypted = dpapi("Protect", &plaintext)?;
    plaintext.zeroize();
    write_durable(&output_path, encrypted.as_bytes())?;
    println!(
        "{{\"network\":\"testnet\",\"viewer_dpapi_created\":true,\"birthday\":{},\"receive_address\":\"{}\",\"checkpoint_height\":{},\"checkpoint_hash\":\"{}\"}}",
        viewer.birthday, viewer.receiver_address, checkpoint.height, checkpoint.hash
    );
    Ok(())
}

struct Checkpoint {
    height: u32,
    hash: String,
}

async fn fetch_checkpoint(uri: &Uri, height: u32) -> Result<Checkpoint> {
    let mut indexer = GrpcIndexer::new(uri.clone())
        .await
        .context("connect to testnet indexer for checkpoint")?;
    let block = indexer
        .get_block(
            BlockId {
                height: u64::from(height),
                hash: vec![],
            },
            DEFAULT_REQUEST_TIMEOUT,
        )
        .await
        .context("fetch checkpoint compact block")?;
    ensure!(
        block.height == u64::from(height),
        "checkpoint response has wrong height"
    );
    let (hash, _) = compact_block_hashes(&block)?;
    Ok(Checkpoint {
        height,
        hash: hash.to_string(),
    })
}

async fn emit_checkpoint(confirmations: u32) -> Result<()> {
    ensure!(confirmations > 0, "CONFIRMATIONS must be positive");
    let uri: Uri = TESTNET_INDEXER
        .parse()
        .context("parse pinned testnet indexer URI")?;
    let tip = testnet_tip(&uri).await?;
    let height = tip
        .checked_sub(confirmations - 1)
        .context("tip is below requested checkpoint confirmation depth")?;
    let checkpoint = fetch_checkpoint(&uri, height).await?;
    println!(
        "{{\"network\":\"testnet\",\"checkpoint_height\":{},\"checkpoint_hash\":\"{}\",\"observed_tip_height\":{},\"confirmations\":{}}}",
        checkpoint.height, checkpoint.hash, tip, confirmations
    );
    Ok(())
}

async fn emit_wallet_status(state_dir: PathBuf, uri: Uri) -> Result<()> {
    let recovery = load_recovery(&state_dir.join(RECOVERY_FILE))?;
    let mut sender = restore_wallet(
        uri.clone(),
        "sender",
        SENDER_WALLET_NAME,
        &recovery.sender_seed,
        recovery.birthday,
    )
    .await?;
    let address = new_shielded_address(&mut sender).await?;
    ensure!(
        address == recovery.sender_address,
        "restored sender address differs from encrypted recovery"
    );
    sender
        .sync_to_tip_and_await()
        .await
        .context("sync sender for status")?;
    let spendable = sender
        .wallet()
        .read()
        .await
        .shielded_spendable_balance(AccountId::ZERO, false)
        .context("read shielded spendable balance")?
        .into_u64();
    let tip = testnet_tip(&uri).await?;
    println!(
        "{{\"network\":\"testnet\",\"tipHeight\":{tip},\"receiveAddress\":\"{address}\",\"spendableZatoshi\":{spendable}}}"
    );
    Ok(())
}

/// Construct the same shielded payment shape used by live commands, then
/// discard its in-memory proposal. No command journal or send path is entered.
async fn emit_command_estimate(state_dir: PathBuf, uri: Uri) -> Result<()> {
    let _ = testnet_tip(&uri).await?;
    let recovery = load_recovery(&state_dir.join(RECOVERY_FILE))?;
    let mut sender = restore_wallet(
        uri,
        "sender",
        SENDER_WALLET_NAME,
        &recovery.sender_seed,
        recovery.birthday,
    )
    .await?;
    let address = new_shielded_address(&mut sender).await?;
    ensure!(
        address == recovery.sender_address,
        "restored sender address differs from encrypted recovery"
    );
    sender
        .sync_to_tip_and_await()
        .await
        .context("sync sender for command fee estimation")?;
    let spendable = sender
        .wallet()
        .read()
        .await
        .shielded_spendable_balance(AccountId::ZERO, false)
        .context("read shielded spendable balance")?
        .into_u64();
    // Arbitrary binary memo, intentionally not a signed Canary command. Its
    // exact 512-byte size and destination match the real transport payment.
    let mut memo = [0u8; MEMO_WIRE_LEN];
    memo[MEMO_PREFIX_INDEX] = MEMO_PREFIX;
    let request = memo_payment_request(&recovery.receiver_address, memo)?;
    let proposal = sender
        .propose_send(request, AccountId::ZERO)
        .await
        .context("estimate send proposal; no broadcast attempted")?;
    let estimate = (|| -> Result<(u64, u64, u64)> {
        ensure!(
            proposal.steps().len() == 1,
            "command estimate must use one transaction"
        );
        let amount = zingolib::data::proposal::total_payment_amount(&proposal)
            .context("read actual proposed payment amount")?
            .into_u64();
        ensure!(
            amount == SEND_AMOUNT_ZATOSHI,
            "proposal changed command note amount"
        );
        let fee = zingolib::data::proposal::total_fee(&proposal)
            .context("read actual proposed ZIP-317 fee")?
            .into_u64();
        let total = amount
            .checked_add(fee)
            .context("estimated command total overflow")?;
        ensure!(
            spendable >= total,
            "estimated command exceeds shielded spendable funds"
        );
        Ok((fee, amount, total))
    })();
    sender.clear_proposal().await;
    let (fee, amount, total) = estimate?;
    println!(
        "{{\"network\":\"testnet\",\"feeZatoshi\":{fee},\"noteAmountZatoshi\":{amount},\"totalZatoshi\":{total},\"spendableZatoshi\":{spendable}}}"
    );
    Ok(())
}

async fn testnet_tip(uri: &Uri) -> Result<u32> {
    let mut indexer = GrpcIndexer::new(uri.clone())
        .await
        .context("connect to pinned TLS testnet indexer")?;
    let info = indexer
        .get_lightd_info(DEFAULT_REQUEST_TIMEOUT)
        .await
        .context("read lightwallet server information")?;
    ensure!(
        info.chain_name == TESTNET_CHAIN_NAME,
        "indexer reports chain {:?}, expected test",
        info.chain_name
    );
    let tip = u32::try_from(info.block_height).context("testnet height fits wallet height type")?;
    ensure!(
        tip >= lib_birthday(TESTNET),
        "testnet tip is below activation floor"
    );
    Ok(tip)
}

async fn scan_batch(args: ScanBatchArgs) -> Result<()> {
    ensure!(args.confirmations > 0, "CONFIRMATIONS must be positive");
    let viewer_record = load_viewer_record(&args.viewer_path)?;
    ensure!(
        args.start_height > viewer_record.birthday,
        "START_HEIGHT must follow the viewer birthday checkpoint"
    );
    let checkpoint_height = args
        .start_height
        .checked_sub(1)
        .context("START_HEIGHT has no predecessor")?;
    let expected_prev_hash = parse_block_hash_display(&args.expected_prev_hash)?;
    let uri: Uri = TESTNET_INDEXER
        .parse()
        .context("parse pinned testnet indexer URI")?;
    let mut checkpoint_indexer = GrpcIndexer::new(uri.clone())
        .await
        .context("connect to testnet checkpoint indexer")?;
    let checkpoint_block = checkpoint_indexer
        .get_block(
            BlockId {
                height: u64::from(checkpoint_height),
                hash: vec![],
            },
            DEFAULT_REQUEST_TIMEOUT,
        )
        .await
        .context("fetch expected previous block checkpoint")?;
    ensure!(
        checkpoint_block.height == u64::from(checkpoint_height),
        "previous block checkpoint has wrong height"
    );
    let (checkpoint_hash, _) = compact_block_hashes(&checkpoint_block)?;
    ensure!(
        checkpoint_hash == expected_prev_hash,
        "expected previous hash does not match indexer checkpoint"
    );

    let mut viewer = new_viewing_wallet(
        uri.clone(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(STATE_DIRECTORY)
            .join("batch-viewer"),
        viewer_record.ufvk.clone(),
        viewer_record.birthday,
    )
    .await?;
    ensure_viewing_only(&viewer).await?;
    let viewer_address = new_shielded_address(&mut viewer).await?;
    ensure!(
        viewer_address == viewer_record.receiver_address,
        "view-only file address does not match the UFVK"
    );
    viewer
        .sync_to_tip_and_await()
        .await
        .context("sync UFVK-only batch scanner to tip")?;
    let observed_tip = testnet_tip(&uri).await?;
    let confirmation_offset = args.confirmations - 1;
    let Some(finalized_through) = observed_tip.checked_sub(confirmation_offset) else {
        bail!("testnet tip has not reached the requested confirmation depth");
    };
    if finalized_through < args.start_height {
        println!(
            "{{\"adapter\":\"testnet-chain\",\"network\":1,\"complete\":false,\"status\":\"no-new-blocks\",\"confirmed_through\":{},\"observed_tip_height\":{},\"blocks\":[]}}",
            finalized_through.min(checkpoint_height),
            observed_tip
        );
        return Ok(());
    }
    let batch_limit = args
        .start_height
        .checked_add(MAX_BATCH_BLOCKS - 1)
        .unwrap_or(u32::MAX);
    let end_height = finalized_through.min(batch_limit);
    let mut indexer = GrpcIndexer::new(uri)
        .await
        .context("connect to testnet block-range indexer")?;
    let range = BlockRange {
        start: Some(BlockId {
            height: u64::from(args.start_height),
            hash: vec![],
        }),
        end: Some(BlockId {
            height: u64::from(end_height),
            hash: vec![],
        }),
        pool_types: vec![
            zingo_netutils::lightwallet_protocol::PoolType::Sapling as i32,
            zingo_netutils::lightwallet_protocol::PoolType::Orchard as i32,
            zingo_netutils::lightwallet_protocol::PoolType::Ironwood as i32,
        ],
    };
    let mut stream = indexer
        .get_block_range(range, FINITE_STREAM_TIMEOUT)
        .await
        .context("request contiguous compact block range")?;

    let mut wallet_txids = HashSet::new();
    let mut memo_events: HashMap<zcash_protocol::TxId, (u32, Vec<MemoEventOutput>)> =
        HashMap::new();
    {
        let wallet = viewer.wallet().read().await;
        for tx in wallet.wallet_transactions.values() {
            let Some(height) = tx.status().get_confirmed_height() else {
                continue;
            };
            let height = u32::from(height);
            if height < args.start_height || height > end_height {
                continue;
            }
            let txid = tx.txid();
            ensure!(
                wallet_txids.insert(txid),
                "duplicate wallet transaction id in scanned range"
            );
            let mut outputs = Vec::new();
            collect_arbitrary_memos::<SaplingNote>(tx, &mut outputs)?;
            collect_arbitrary_memos::<OrchardNote>(tx, &mut outputs)?;
            collect_arbitrary_memos::<IronwoodNote>(tx, &mut outputs)?;
            if !outputs.is_empty() {
                memo_events.insert(txid, (height, outputs));
            }
        }
    }

    let expected_blocks = u64::from(end_height - args.start_height) + 1;
    let mut serialized_blocks = Vec::with_capacity(expected_blocks as usize);
    let mut expected_height = args.start_height;
    let mut previous_hash = expected_prev_hash;
    let mut actual_blocks = 0u64;
    while let Some(block) = tokio::time::timeout(STREAM_MSG_TIMEOUT, stream.message())
        .await
        .context("timed out waiting for compact block")?
        .context("compact block stream failed")?
    {
        let block_height =
            u32::try_from(block.height).context("compact block height exceeds wallet type")?;
        ensure!(
            block_height == expected_height,
            "compact block range has a height gap or reordering"
        );
        let (block_hash, block_prev_hash) = compact_block_hashes(&block)?;
        ensure!(
            block_prev_hash == previous_hash,
            "compact block previous hash does not link to the verified checkpoint"
        );
        let mut indices = HashSet::new();
        let mut serialized_transactions = Vec::new();
        let mut txids_in_block = HashSet::new();
        for compact_tx in &block.vtx {
            ensure!(
                indices.insert(compact_tx.index),
                "duplicate transaction index in compact block"
            );
            ensure!(
                compact_tx.txid.len() == 32,
                "compact transaction ID is not 32 bytes"
            );
            let txid_bytes: [u8; 32] = compact_tx
                .txid
                .as_slice()
                .try_into()
                .expect("length checked");
            let txid = zcash_protocol::TxId::from_bytes(txid_bytes);
            ensure!(
                txids_in_block.insert(txid),
                "duplicate transaction ID in compact block"
            );
            wallet_txids.remove(&txid);
            if let Some((memo_height, outputs)) = memo_events.remove(&txid) {
                ensure!(
                    memo_height == block_height,
                    "decrypted wallet transaction appears at a different block height"
                );
                let serialized_outputs = outputs
                    .into_iter()
                    .map(|output| {
                        format!(
                            "{{\"tx_index\":{},\"output_index\":{},\"memo_hex\":\"{}\"}}",
                            compact_tx.index, output.output_index, output.memo_hex
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                serialized_transactions.push(format!("{{\"txid_hex\":\"{txid}\",\"tx_index\":{},\"outputs\":[{serialized_outputs}]}}", compact_tx.index));
            }
        }
        ensure!(
            expected_height <= end_height,
            "indexer returned more blocks than requested"
        );
        serialized_blocks.push(format!("{{\"height\":{block_height},\"hash_hex\":\"{}\",\"previous_hash_hex\":\"{}\",\"transactions\":[{}]}}", block_hash, block_prev_hash, serialized_transactions.join(",")));
        actual_blocks += 1;
        previous_hash = block_hash;
        if block_height < end_height {
            expected_height = expected_height
                .checked_add(1)
                .context("block height overflow")?;
        }
    }
    ensure!(
        actual_blocks == expected_blocks,
        "compact block stream ended early: expected {expected_blocks} blocks, received {actual_blocks}"
    );
    ensure!(
        wallet_txids.is_empty(),
        "the compact range omitted one or more transactions decrypted by the UFVK scanner"
    );
    ensure!(
        memo_events.is_empty(),
        "the compact range omitted one or more decrypted memo transactions"
    );
    println!(
        "{{\"adapter\":\"testnet-chain\",\"network\":1,\"complete\":true,\"confirmed_through\":{end_height},\"observed_tip_height\":{observed_tip},\"blocks\":[{}]}}",
        serialized_blocks.join(",")
    );
    Ok(())
}

fn collect_arbitrary_memos<N: NoteInterface>(
    tx: &WalletTransaction,
    output: &mut Vec<MemoEventOutput>,
) -> Result<()> {
    for note in N::transaction_outputs(tx) {
        if let Memo::Arbitrary(payload) = note.memo() {
            let mut wire = [0u8; MEMO_WIRE_LEN];
            wire[MEMO_PREFIX_INDEX] = MEMO_PREFIX;
            wire[MEMO_PREFIX_LEN..].copy_from_slice(payload.as_ref());
            output.push(MemoEventOutput {
                output_index: note.output_id().output_index(),
                memo_hex: hex::encode(wire),
            });
        }
    }
    Ok(())
}

fn parse_block_hash_display(value: &str) -> Result<BlockHash> {
    let mut bytes = hex::decode(value).context("decode expected previous block hash")?;
    ensure!(
        bytes.len() == 32,
        "expected previous block hash must be 32 bytes"
    );
    bytes.reverse();
    BlockHash::try_from_slice(&bytes).context("construct expected previous block hash")
}

fn compact_block_hashes(block: &CompactBlock) -> Result<(BlockHash, BlockHash)> {
    let hash =
        BlockHash::try_from_slice(&block.hash).context("compact block hash must be 32 bytes")?;
    let previous_hash = BlockHash::try_from_slice(&block.prev_hash)
        .context("compact previous hash must be 32 bytes")?;
    if !block.header.is_empty() {
        let header =
            BlockHeader::read(Cursor::new(&block.header)).context("parse compact block header")?;
        ensure!(
            header.hash() == hash,
            "compact block hash disagrees with full header hash"
        );
        ensure!(
            header.prev_block == previous_hash,
            "compact previous hash disagrees with full header"
        );
    }
    Ok((hash, previous_hash))
}

fn load_verified_command(path: &Path) -> Result<([u8; MEMO_WIRE_LEN], zcanary_core::Command)> {
    let encoded = std::fs::read_to_string(path).context("read signed Z-CANARY memo hex file")?;
    let decoded = hex::decode(encoded.trim()).context("decode signed memo hex")?;
    let memo: [u8; MEMO_WIRE_LEN] = decoded.try_into().map_err(|bytes: Vec<u8>| {
        anyhow::anyhow!("signed memo must be exactly 512 bytes, got {}", bytes.len())
    })?;
    let command =
        decode_and_verify_memo(&memo, 1).context("verify signed testnet Z-CANARY memo")?;
    Ok((memo, command))
}

fn operation_name(operation: Operation) -> &'static str {
    match operation {
        Operation::Register => "REGISTER",
        Operation::Postpone => "POSTPONE",
        Operation::Cancel => "CANCEL",
    }
}

async fn create_recovery(uri: Uri, birthday: u32) -> Result<Recovery> {
    let state_dir = wallet_state_dir()?;
    let mut sender = new_spending_wallet(
        uri.clone(),
        state_dir.join("sender"),
        SENDER_WALLET_NAME,
        birthday,
    )
    .await?;
    let sender_address = new_shielded_address(&mut sender).await?;
    let sender_seed = sender.mnemonic_phrase().context("sender mnemonic exists")?;
    let mut receiver = new_spending_wallet(
        uri,
        state_dir.join("receiver"),
        RECEIVER_WALLET_NAME,
        birthday,
    )
    .await?;
    let receiver_address = new_shielded_address(&mut receiver).await?;
    let receiver_seed = receiver
        .mnemonic_phrase()
        .context("receiver mnemonic exists")?;
    Ok(Recovery {
        birthday,
        sender_seed,
        sender_address,
        receiver_seed,
        receiver_address,
    })
}

fn encode_recovery(r: &Recovery) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n",
        r.birthday, r.sender_seed, r.sender_address, r.receiver_seed, r.receiver_address
    )
}
fn decode_recovery(s: &str) -> Result<Recovery> {
    let mut lines = s.lines();
    let birthday = lines
        .next()
        .context("missing birthday")?
        .parse()
        .context("invalid birthday")?;
    let sender_seed = lines.next().context("missing sender seed")?.to_owned();
    let sender_address = lines.next().context("missing sender address")?.to_owned();
    let receiver_seed = lines.next().context("missing receiver seed")?.to_owned();
    let receiver_address = lines.next().context("missing receiver address")?.to_owned();
    ensure!(lines.next().is_none(), "invalid recovery payload");
    Ok(Recovery {
        birthday,
        sender_seed,
        sender_address,
        receiver_seed,
        receiver_address,
    })
}

fn load_recovery(path: &Path) -> Result<Recovery> {
    let encrypted = std::fs::read_to_string(path).context("read encrypted recovery file")?;
    let mut plaintext = dpapi("Unprotect", &encrypted)?;
    let recovery = decode_recovery(&plaintext);
    plaintext.zeroize();
    recovery
}

async fn restore_wallet(
    uri: Uri,
    name: &str,
    wallet_name: &str,
    seed: &str,
    birthday: u32,
) -> Result<LightClient> {
    let account_count = NonZeroU32::new(ACCOUNT_COUNT).unwrap();
    let config = ClientConfig::builder()
        .set_chain_type(TESTNET)
        .set_wallet_dir(wallet_state_dir()?.join(name))
        .set_wallet_name(wallet_name.to_owned())
        .set_wallet_config(WalletConfig::MnemonicPhrase {
            mnemonic_phrase: seed.to_owned(),
            no_of_accounts: account_count,
            birthday,
            wallet_settings: WalletSettings::default(),
        })
        .set_indexer_uri(uri)
        .build()
        .context("build deterministic restored wallet")?;
    LightClient::new(config, false)
        .await
        .context("restore deterministic wallet")
}

fn dpapi(operation: &str, input: &str) -> Result<String> {
    // DPAPI helper receives data on stdin; plaintext never appears in process arguments or disk.
    let mut encoded = if operation == "Protect" {
        base64::engine::general_purpose::STANDARD.encode(input.as_bytes())
    } else {
        input.trim().to_owned()
    };
    let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dpapi.ps1");
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(helper)
        .arg(operation)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("start Windows DPAPI helper")?;
    use std::io::Write;
    let write_result = child
        .stdin
        .take()
        .context("DPAPI stdin")?
        .write_all(encoded.as_bytes());
    encoded.zeroize();
    write_result.context("write DPAPI stdin")?;
    let output = child.wait_with_output().context("wait for DPAPI helper")?;
    ensure!(output.status.success(), "Windows DPAPI operation failed");
    let out = String::from_utf8(output.stdout).context("DPAPI output is UTF-8")?;
    if operation == "Protect" {
        Ok(out.trim().to_owned())
    } else {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(out.trim())
            .context("decode DPAPI recovery payload")?;
        Ok(String::from_utf8(bytes).context("recovery payload UTF-8")?)
    }
}

fn write_durable(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .context("create persistent state file")?;
    f.write_all(bytes).context("write persistent state")?;
    f.sync_all().context("flush persistent state")
}
fn write_replace(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .context("open send state for txid update")?;
    f.write_all(bytes).context("write public txid")?;
    f.sync_all().context("flush public txid")
}

async fn verify_testnet_indexer(uri: Uri) -> Result<u32> {
    let mut indexer = GrpcIndexer::new(uri)
        .await
        .context("connect to pinned TLS testnet indexer")?;
    let info = indexer
        .get_lightd_info(DEFAULT_REQUEST_TIMEOUT)
        .await
        .context("read lightwallet server information")?;
    ensure!(
        info.chain_name == TESTNET_CHAIN_NAME,
        "indexer reports chain {:?}, expected test",
        info.chain_name
    );
    let tip_height = u32::try_from(info.block_height)
        .context("testnet indexer height fits wallet block-height type")?;
    let birthday = tip_height.saturating_sub(BIRTHDAY_TIP_MARGIN);
    ensure!(
        birthday >= lib_birthday(TESTNET),
        "testnet tip is too low for a recent wallet birthday"
    );
    println!("indexer_chain={}", info.chain_name);
    println!("indexer_height={tip_height}");
    println!("wallet_birthday={birthday}");
    Ok(birthday)
}

async fn new_spending_wallet(
    indexer_uri: Uri,
    wallet_directory: PathBuf,
    wallet_name: &str,
    birthday: u32,
) -> Result<LightClient> {
    let account_count = NonZeroU32::new(ACCOUNT_COUNT).context("account count is nonzero")?;
    let wallet_config = WalletConfig::NewSeed {
        no_of_accounts: account_count,
        chain_height: birthday
            .checked_add(NEW_SEED_CHAIN_HEIGHT_MARGIN)
            .context("NewSeed chain height fits wallet block-height type")?,
        wallet_settings: WalletSettings::default(),
    };
    let config = ClientConfig::builder()
        .set_chain_type(TESTNET)
        .set_wallet_dir(wallet_directory)
        .set_wallet_name(wallet_name.to_owned())
        .set_wallet_config(wallet_config)
        .set_indexer_uri(indexer_uri)
        .build()
        .context("build fresh testnet wallet configuration")?;
    LightClient::new(config, false)
        .await
        .context("create fresh in-memory testnet wallet")
}

async fn new_viewing_wallet(
    indexer_uri: Uri,
    wallet_directory: PathBuf,
    ufvk: String,
    birthday: u32,
) -> Result<LightClient> {
    let config = ClientConfig::builder()
        .set_chain_type(TESTNET)
        .set_wallet_dir(wallet_directory)
        .set_wallet_name(VIEWER_WALLET_NAME.to_owned())
        .set_wallet_config(WalletConfig::Ufvk {
            ufvk,
            birthday,
            wallet_settings: WalletSettings::default(),
        })
        .set_indexer_uri(indexer_uri)
        .build()
        .context("build fresh view-only testnet wallet configuration")?;
    LightClient::new(config, false)
        .await
        .context("create fresh in-memory view-only testnet wallet")
}

async fn new_shielded_address(client: &mut LightClient) -> Result<String> {
    let (_, address) = client
        .generate_unified_address(ReceiverSelection::all_shielded(), AccountId::ZERO)
        .await
        .context("derive shielded testnet address")?;
    Ok(address.encode(&TESTNET))
}

async fn wallet_ufvk(client: &LightClient) -> Result<String> {
    let wallet = client.wallet().read().await;
    let key_store = wallet
        .unified_key_store
        .get(&AccountId::ZERO)
        .context("account zero has a key store")?;
    let ufvk =
        UnifiedFullViewingKey::try_from(key_store).context("derive receiver full viewing key")?;
    Ok(encode_ufvk(&ufvk, &TESTNET))
}

async fn ensure_viewing_only(client: &LightClient) -> Result<()> {
    ensure!(
        client.mnemonic_phrase().is_none(),
        "view-only wallet has no seed"
    );
    let wallet = client.wallet().read().await;
    let key_store = wallet
        .unified_key_store
        .get(&AccountId::ZERO)
        .context("view-only account has a key store")?;
    ensure!(
        !key_store.is_spending_key(),
        "scanner must not have spend capability"
    );
    Ok(())
}

async fn wait_for_spendable_funds(sender: &mut LightClient) -> Result<()> {
    loop {
        sender
            .sync_to_tip_and_await()
            .await
            .context("sync sender wallet before funding check")?;
        let spendable = sender
            .wallet()
            .read()
            .await
            .shielded_spendable_balance(AccountId::ZERO, false)
            .context("calculate confirmed shielded spendable balance")?
            .into_u64();
        let minimum = SEND_AMOUNT_ZATOSHI + MIN_SEND_FEE_RESERVE_ZATOSHI;
        println!("shielded_spendable_balance_zatoshi={spendable}");
        if spendable >= minimum {
            println!("funding_spendable=true");
            break;
        }
        println!("funding_not_spendable_yet=true");
        tokio::time::sleep(FUNDING_RETRY_DELAY).await;
    }
    Ok(())
}

async fn prepare_memo_send(
    sender: &mut LightClient,
    receiver_address: &str,
    fixture: [u8; MEMO_WIRE_LEN],
) -> Result<()> {
    let request = memo_payment_request(receiver_address, fixture)?;
    sender
        .propose_send(request, AccountId::ZERO)
        .await
        .context("preflight send proposal; no broadcast attempted")?;
    Ok(())
}

fn memo_payment_request(
    receiver_address: &str,
    fixture: [u8; MEMO_WIRE_LEN],
) -> Result<TransactionRequest> {
    let recipient = ZcashAddress::try_from_encoded(receiver_address)
        .context("parse receiver testnet address")?;
    let amount = Zatoshis::from_u64(SEND_AMOUNT_ZATOSHI).context("validate send amount")?;
    let memo = MemoBytes::from_bytes(&fixture).context("construct exact 512-byte memo")?;
    let payment = Payment::new(recipient, Some(amount), Some(memo), None, None, vec![])
        .context("construct shielded ZIP-321 payment")?;
    TransactionRequest::new(vec![payment]).context("construct send request")
}

async fn send_prepared_memo(sender: &mut LightClient) -> Result<zcash_protocol::TxId> {
    let txids = sender
        .send_stored_proposal(true)
        .await
        .context("transmit preflighted shielded transaction")?;
    ensure!(
        txids.len() == 1,
        "one payment should produce exactly one transaction; got {}",
        txids.len()
    );
    Ok(txids.head)
}

async fn scan_exact_memo(
    viewer: &mut LightClient,
    expected_txid: zcash_protocol::TxId,
    fixture: &[u8; MEMO_WIRE_LEN],
) -> Result<ScanEvidence> {
    for attempt in FIRST_ATTEMPT_INDEX..SCAN_ATTEMPTS {
        viewer
            .sync_to_tip_and_await()
            .await
            .context("sync viewing-only scanner")?;
        if let Some(evidence) = find_confirmed_memo(viewer, expected_txid, fixture).await? {
            return Ok(evidence);
        }
        if attempt + ATTEMPT_ORDINAL_OFFSET < SCAN_ATTEMPTS {
            println!("scanner_waiting_for_confirmed_memo=true");
            tokio::time::sleep(SCAN_RETRY_DELAY).await;
        }
    }
    bail!("the independent viewing-only scan did not recover the confirmed memo")
}

async fn scan_exact_memo_any(
    viewer: &mut LightClient,
    fixture: &[u8; MEMO_WIRE_LEN],
) -> Result<(zcash_protocol::TxId, ScanEvidence)> {
    for attempt in FIRST_ATTEMPT_INDEX..SCAN_ATTEMPTS {
        viewer
            .sync_to_tip_and_await()
            .await
            .context("sync viewing-only recovery scanner")?;
        let matches = {
            let wallet = viewer.wallet().read().await;
            let mut found = Vec::new();
            for transaction in wallet.wallet_transactions.values() {
                let Some(height) = transaction.status().get_confirmed_height() else {
                    continue;
                };
                let output_id = find_wire_memo::<SaplingNote>(transaction, fixture)
                    .or_else(|| find_wire_memo::<OrchardNote>(transaction, fixture))
                    .or_else(|| find_wire_memo::<IronwoodNote>(transaction, fixture));
                let Some(output_id) = output_id else { continue };
                let block = wallet
                    .wallet_blocks
                    .get(&height)
                    .context("confirmed recovery transaction block is in scanner wallet")?;
                found.push((
                    transaction.txid(),
                    ScanEvidence {
                        height,
                        block_hash: block.block_hash().to_string(),
                        output_id,
                    },
                ));
            }
            found
        };
        ensure!(
            matches.len() <= 1,
            "multiple confirmed transactions contain the exact recovery memo; refusing to choose one"
        );
        if let Some(found) = matches.into_iter().next() {
            return Ok(found);
        }
        if attempt + ATTEMPT_ORDINAL_OFFSET < SCAN_ATTEMPTS {
            println!("recovery_scanner_waiting_for_exact_memo=true");
            tokio::time::sleep(SCAN_RETRY_DELAY).await;
        }
    }
    bail!(
        "independent UFVK scan found no confirmed transaction with the exact recovery memo; ambiguous send marker remains unchanged"
    )
}

async fn find_confirmed_memo(
    viewer: &LightClient,
    expected_txid: zcash_protocol::TxId,
    fixture: &[u8; MEMO_WIRE_LEN],
) -> Result<Option<ScanEvidence>> {
    let wallet = viewer.wallet().read().await;
    let Some(transaction) = wallet
        .wallet_transactions
        .values()
        .find(|transaction| transaction.txid() == expected_txid)
    else {
        return Ok(None);
    };
    let Some(height) = transaction.status().get_confirmed_height() else {
        return Ok(None);
    };
    let output_id = find_wire_memo::<SaplingNote>(transaction, fixture)
        .or_else(|| find_wire_memo::<OrchardNote>(transaction, fixture))
        .or_else(|| find_wire_memo::<IronwoodNote>(transaction, fixture));
    let Some(output_id) = output_id else {
        return Ok(None);
    };
    let block = wallet
        .wallet_blocks
        .get(&height)
        .context("confirmed transaction block is in scanner wallet")?;
    Ok(Some(ScanEvidence {
        height,
        block_hash: block.block_hash().to_string(),
        output_id,
    }))
}

fn find_wire_memo<N: NoteInterface>(
    transaction: &WalletTransaction,
    fixture: &[u8; MEMO_WIRE_LEN],
) -> Option<OutputId> {
    N::transaction_outputs(transaction)
        .iter()
        .find_map(|note| match note.memo() {
            Memo::Arbitrary(payload) => {
                let mut wire = [0u8; MEMO_WIRE_LEN];
                wire[MEMO_PREFIX_INDEX] = MEMO_PREFIX;
                wire[MEMO_PREFIX_LEN..].copy_from_slice(&payload[..]);
                (wire == *fixture).then_some(note.output_id())
            }
            _ => None,
        })
}

fn memo_fixture() -> Result<[u8; MEMO_WIRE_LEN]> {
    let decoded = hex::decode(include_str!("../memo-fixture.hex").trim())
        .context("decode public synthetic memo fixture")?;
    let wire: [u8; MEMO_WIRE_LEN] = decoded
        .try_into()
        .map_err(|bytes: Vec<u8>| anyhow::anyhow!("memo fixture has {} bytes", bytes.len()))?;
    ensure!(
        wire[MEMO_PREFIX_INDEX] == MEMO_PREFIX,
        "fixture has ZIP-302 arbitrary prefix"
    );
    Ok(wire)
}

struct ScanEvidence {
    height: zcash_protocol::consensus::BlockHeight,
    block_hash: String,
    output_id: OutputId,
}
