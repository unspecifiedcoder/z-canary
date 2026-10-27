use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use zcanary_core::{Operation, decode_and_verify_memo};

#[derive(Clone)]
pub struct Keeper {
    conn: Arc<Mutex<Connection>>,
    suspended: Arc<AtomicBool>,
    dispatch_gate: Arc<Mutex<()>>,
    network: u8,
    keeper_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Draft,
    Active,
    Grace,
    Cancelled,
    Released,
}

/// Public protocol state read atomically from the keeper's applied chain state.
/// This deliberately excludes encrypted share payloads and source material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultState {
    pub lifecycle: Lifecycle,
    pub expiry_height: Option<u32>,
    pub last_sequence: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub initial_interval: u32,
    pub max_extension: u32,
    pub confirmation_count: u32,
    pub grace_period: u32,
}
#[derive(Clone, Debug)]
pub struct ProvisioningRecord {
    pub switch_id: [u8; 32],
    pub manifest_digest: [u8; 32],
    pub source_pubkey: [u8; 32],
    pub epoch: u32,
    pub keeper_index: u8,
    pub policy: Policy,
    /// Opaque recipient-encrypted share bytes. The keeper never decrypts this field.
    pub encrypted_share_envelope: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct ScannedOutput {
    pub tx_index: u32,
    pub output_index: u32,
    pub memo: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct ScannedTransaction {
    pub txid: [u8; 32],
    pub tx_index: u32,
    pub outputs: Vec<ScannedOutput>,
}
#[derive(Clone, Debug)]
pub struct ScannedBlock {
    pub height: u32,
    pub hash: [u8; 32],
    pub previous_hash: [u8; 32],
    pub transactions: Vec<ScannedTransaction>,
}
#[derive(Clone, Debug)]
pub struct ConfirmedBatch {
    pub blocks: Vec<ScannedBlock>,
    pub confirmed_through: u32,
    pub observed_tip_height: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub height: u32,
    pub hash: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub id: i64,
    pub idempotency_key: String,
    pub switch_id: [u8; 32],
    pub epoch: u32,
    pub manifest_digest: [u8; 32],
    pub encrypted_share_envelope: Vec<u8>,
    pub cursor: Cursor,
}
#[derive(Debug)]
pub enum KeeperError {
    Sql(String),
    Invalid(String),
    AlreadyInitialized,
    IncompleteBatch,
    InsufficientConfirmations,
    ReorgIncident,
    Suspended,
    NotFound,
    StaleCursor,
    Poisoned,
}
impl From<rusqlite::Error> for KeeperError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e.to_string())
    }
}
type Result<T> = std::result::Result<T, KeeperError>;

impl Keeper {
    /// Test-only convenience using the implicit height-zero genesis start.
    /// Production callers must use `open_at_checkpoint` with an anchor verified by the wallet adapter.
    pub fn open(path: impl AsRef<Path>, network: u8, keeper_id: impl Into<String>) -> Result<Self> {
        Self::open_impl(path, network, keeper_id.into(), None, false)
    }
    /// Initialize a new database from a wallet-adapter-verified chain checkpoint.
    /// The checkpoint is trusted input; this method does not verify its canonicality.
    pub fn open_at_checkpoint(
        path: impl AsRef<Path>,
        network: u8,
        keeper_id: impl Into<String>,
        checkpoint: Cursor,
    ) -> Result<Self> {
        Self::open_impl(path, network, keeper_id.into(), Some(checkpoint), false)
    }
    /// Reopen an already initialized database without changing its durable cursor.
    pub fn open_existing(
        path: impl AsRef<Path>,
        network: u8,
        keeper_id: impl Into<String>,
    ) -> Result<Self> {
        Self::open_impl(path, network, keeper_id.into(), None, true)
    }
    fn open_impl(
        path: impl AsRef<Path>,
        network: u8,
        keeper_id: String,
        checkpoint: Option<Cursor>,
        require_existing: bool,
    ) -> Result<Self> {
        if network > 1 {
            return Err(KeeperError::Invalid("unsupported network".into()));
        }
        if keeper_id.is_empty() {
            return Err(KeeperError::Invalid("empty keeper identity".into()));
        }
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let tx = conn.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS switches (switch_id BLOB PRIMARY KEY CHECK(length(switch_id)=32), manifest BLOB NOT NULL CHECK(length(manifest)=32), source BLOB NOT NULL CHECK(length(source)=32), registration_height INTEGER, initial_interval INTEGER NOT NULL, expires INTEGER, max_extension INTEGER NOT NULL, confirmations INTEGER NOT NULL, grace INTEGER NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0 AND epoch <= 4294967295), keeper_index INTEGER NOT NULL, last_seq BLOB CHECK(last_seq IS NULL OR length(last_seq)=8), lifecycle TEXT NOT NULL, envelope BLOB NOT NULL, idempotency_key TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, switch_id BLOB NOT NULL REFERENCES switches(switch_id), idempotency_key TEXT NOT NULL UNIQUE, payload BLOB NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','DELIVERED','SUPPRESSED')), attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE, previous_hash BLOB NOT NULL);")?;
        let configured_network = [network];
        for (key, value) in [
            ("network", configured_network.as_slice()),
            ("keeper_id", keeper_id.as_bytes()),
        ] {
            let saved: Option<Vec<u8>> = tx
                .query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(saved) = saved {
                if saved != value {
                    return Err(KeeperError::Invalid(
                        "database belongs to a different network or keeper identity".into(),
                    ));
                }
            } else {
                tx.execute(
                    "INSERT INTO meta(key,value) VALUES(?1,?2)",
                    params![key, value],
                )?;
            }
        }
        let has_cursor: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key='cursor_height')",
            [],
            |r| r.get(0),
        )?;
        let has_history: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM blocks) OR EXISTS(SELECT 1 FROM switches)",
            [],
            |r| r.get(0),
        )?;
        if checkpoint.is_some() && (has_cursor || has_history) {
            return Err(KeeperError::AlreadyInitialized);
        }
        if let Some(anchor) = checkpoint {
            tx.execute(
                "INSERT INTO meta(key,value) VALUES('cursor_height',?1)",
                params![anchor.height.to_be_bytes().as_slice()],
            )?;
            tx.execute(
                "INSERT INTO meta(key,value) VALUES('cursor_hash',?1)",
                params![anchor.hash.as_slice()],
            )?;
        }
        if require_existing && !has_cursor {
            return Err(KeeperError::Invalid(
                "database has no initialized confirmed cursor".into(),
            ));
        }
        tx.execute(
            "INSERT OR IGNORE INTO meta(key,value) VALUES('healthy',x'01')",
            [],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO meta(key,value) VALUES('reorg_incident',x'00')",
            [],
        )?;
        let stored_health: Vec<u8> =
            tx.query_row("SELECT value FROM meta WHERE key='healthy'", [], |r| {
                r.get(0)
            })?;
        let stored_incident: Vec<u8> = tx.query_row(
            "SELECT value FROM meta WHERE key='reorg_incident'",
            [],
            |r| r.get(0),
        )?;
        let suspended = require_existing || stored_health != [1] || stored_incident == [1];
        if require_existing {
            tx.execute("UPDATE meta SET value=x'00' WHERE key='healthy'", [])?;
        }
        tx.commit()?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            suspended: Arc::new(AtomicBool::new(suspended)),
            dispatch_gate: Arc::new(Mutex::new(())),
            network,
            keeper_id,
        })
    }
    pub fn provision(&self, p: ProvisioningRecord) -> Result<()> {
        if p.policy.initial_interval == 0
            || p.policy.max_extension == 0
            || p.policy.confirmation_count == 0
            || p.epoch == 0
            || !(1..=5).contains(&p.keeper_index)
            || p.encrypted_share_envelope.is_empty()
        {
            return Err(KeeperError::Invalid(
                "invalid policy, epoch, keeper index, or empty encrypted share envelope".into(),
            ));
        }
        let idempotency_key =
            delivery_key(&p.switch_id, p.epoch, &self.keeper_id, &p.manifest_digest);
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        let existing = c
            .query_row(
                "SELECT manifest,source,initial_interval,max_extension,confirmations,grace,epoch,keeper_index FROM switches WHERE switch_id=?1",
                params![p.switch_id.as_slice()],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?, r.get::<_, u32>(2)?, r.get::<_, u32>(3)?, r.get::<_, u32>(4)?, r.get::<_, u32>(5)?, r.get::<_, u32>(6)?, r.get::<_, u32>(7)?)),
            )
            .optional()?;
        if let Some((
            manifest,
            source,
            initial,
            max_extension,
            confirmations,
            grace,
            epoch,
            index,
        )) = existing
        {
            if manifest.as_slice() == p.manifest_digest.as_slice()
                && source.as_slice() == p.source_pubkey.as_slice()
                && initial == p.policy.initial_interval
                && max_extension == p.policy.max_extension
                && confirmations == p.policy.confirmation_count
                && grace == p.policy.grace_period
                && epoch == p.epoch
                && index == u32::from(p.keeper_index)
            {
                // Preserve the first validated recipient envelope if the source retries
                // after losing the original acknowledgement.
                return Ok(());
            }
            return Err(KeeperError::Invalid(
                "switch was already provisioned with different metadata".into(),
            ));
        }
        c.execute("INSERT INTO switches(switch_id,manifest,source,registration_height,initial_interval,expires,max_extension,confirmations,grace,epoch,keeper_index,last_seq,lifecycle,envelope,idempotency_key) VALUES(?1,?2,?3,NULL,?4,NULL,?5,?6,?7,?8,?9,NULL,'DRAFT',?10,?11)",params![p.switch_id.as_slice(),p.manifest_digest.as_slice(),p.source_pubkey.as_slice(),p.policy.initial_interval,p.policy.max_extension,p.policy.confirmation_count,p.policy.grace_period,p.epoch,p.keeper_index,p.encrypted_share_envelope,idempotency_key]).map_err(|e| match e {rusqlite::Error::SqliteFailure(_,_)=>KeeperError::Invalid("switch already provisioned or invalid record".into()), other=>KeeperError::from(other)})?;
        Ok(())
    }
    pub fn cursor(&self) -> Result<Option<Cursor>> {
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        cursor_conn(&c)
    }
    pub fn is_healthy(&self) -> Result<bool> {
        if self.suspended.load(Ordering::Acquire) {
            return Ok(false);
        }
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        healthy_conn(&c)
    }
    /// Call when the scanner becomes unavailable or its freshness/canonicality check fails.
    /// A later contiguous confirmed batch is required to restore healthy state.
    pub fn mark_unhealthy(&self) -> Result<()> {
        self.suspended.store(true, Ordering::Release);
        let _gate = self
            .dispatch_gate
            .lock()
            .map_err(|_| KeeperError::Poisoned)?;
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        c.execute("UPDATE meta SET value=x'00' WHERE key='healthy'", [])?;
        Ok(())
    }
    pub fn process_confirmed_batch(&self, batch: ConfirmedBatch) -> Result<Cursor> {
        self.suspended.store(true, Ordering::Release);
        let _gate = self
            .dispatch_gate
            .lock()
            .map_err(|_| KeeperError::Poisoned)?;
        match self.process_confirmed_batch_inner(batch) {
            Ok(cursor) => {
                self.suspended.store(false, Ordering::Release);
                Ok(cursor)
            }
            Err(error) => {
                self.suspended.store(true, Ordering::Release);
                if let Ok(c) = self.conn.lock() {
                    let _ = c.execute("UPDATE meta SET value=x'00' WHERE key='healthy'", []);
                }
                Err(error)
            }
        }
    }
    fn process_confirmed_batch_inner(&self, batch: ConfirmedBatch) -> Result<Cursor> {
        let mut c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        let tx = c.transaction()?;
        if reorg_incident(&tx)? {
            return Err(KeeperError::ReorgIncident);
        }
        if batch.blocks.is_empty() {
            suspend(&tx)?;
            tx.commit()?;
            return Err(KeeperError::IncompleteBatch);
        }
        let old = cursor_tx(&tx)?;
        let expected_height = match old.as_ref() {
            Some(x) => x
                .height
                .checked_add(1)
                .ok_or_else(|| KeeperError::Invalid("cursor height exhausted".into()))?,
            None => 0,
        };
        let expected_prev = old.as_ref().map(|x| x.hash).unwrap_or([0; 32]);
        if batch
            .blocks
            .last()
            .is_none_or(|b| b.height != batch.confirmed_through)
        {
            suspend(&tx)?;
            tx.commit()?;
            return Err(KeeperError::IncompleteBatch);
        }
        let max_confirmations: u32 = tx.query_row(
            "SELECT COALESCE(MAX(confirmations),1) FROM switches",
            [],
            |r| r.get(0),
        )?;
        let required_tip = batch
            .confirmed_through
            .checked_add(max_confirmations.saturating_sub(1))
            .ok_or_else(|| KeeperError::Invalid("confirmation tip height overflow".into()));
        let required_tip = match required_tip {
            Ok(h) => h,
            Err(e) => {
                suspend(&tx)?;
                tx.commit()?;
                return Err(e);
            }
        };
        if batch.observed_tip_height < required_tip {
            suspend(&tx)?;
            tx.commit()?;
            return Err(KeeperError::InsufficientConfirmations);
        }
        let mut prev = expected_prev;
        let mut height = expected_height;
        let mut batch_hashes = std::collections::HashSet::new();
        for (block_index, block) in batch.blocks.iter().enumerate() {
            if block.height > height {
                suspend(&tx)?;
                tx.commit()?;
                return Err(KeeperError::IncompleteBatch);
            }
            if block.height < height {
                latch_reorg(&tx)?;
                tx.commit()?;
                return Err(KeeperError::ReorgIncident);
            }
            if block.previous_hash != prev {
                latch_reorg(&tx)?;
                tx.commit()?;
                return Err(KeeperError::ReorgIncident);
            }
            if validate_positions(&block.transactions).is_err() {
                suspend(&tx)?;
                tx.commit()?;
                return Err(KeeperError::Invalid(
                    "transaction/output positions are duplicate, out of order, or mismatched"
                        .into(),
                ));
            }
            let seen_hash: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM blocks WHERE hash=?1)",
                params![block.hash.as_slice()],
                |r| r.get(0),
            )?;
            if seen_hash || block.hash == prev || !batch_hashes.insert(block.hash) {
                latch_reorg(&tx)?;
                tx.commit()?;
                return Err(KeeperError::ReorgIncident);
            }
            if block.height > batch.confirmed_through {
                suspend(&tx)?;
                tx.commit()?;
                return Err(KeeperError::IncompleteBatch);
            }
            prev = block.hash;
            if block_index + 1 < batch.blocks.len() {
                height = height
                    .checked_add(1)
                    .ok_or_else(|| KeeperError::Invalid("height overflow".into()))?;
            }
        }
        for block in &batch.blocks {
            process_block(&tx, self.network, block)?;
            tx.execute(
                "INSERT INTO blocks(height,hash,previous_hash) VALUES(?1,?2,?3)",
                params![
                    block.height,
                    block.hash.as_slice(),
                    block.previous_hash.as_slice()
                ],
            )?;
        }
        let last = batch.blocks.last().unwrap();
        mark_grace(&tx, last.height)?;
        release_due(&tx, last.height)?;
        tx.execute("INSERT INTO meta(key,value) VALUES('cursor_height',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![last.height.to_be_bytes().as_slice()])?;
        tx.execute("INSERT INTO meta(key,value) VALUES('cursor_hash',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![last.hash.as_slice()])?;
        tx.execute("UPDATE meta SET value=x'01' WHERE key='healthy' AND (SELECT value FROM meta WHERE key='reorg_incident')=x'00'",[])?;
        tx.commit()?;
        Ok(Cursor {
            height: last.height,
            hash: last.hash,
        })
    }
    pub fn lifecycle(&self, switch_id: [u8; 32]) -> Result<Lifecycle> {
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        let s: String = c
            .query_row(
                "SELECT lifecycle FROM switches WHERE switch_id=?1",
                params![switch_id.as_slice()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(KeeperError::NotFound)?;
        parse_lifecycle(&s)
    }
    pub fn vault_state(&self, switch_id: [u8; 32]) -> Result<VaultState> {
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        let row: Option<(String, Option<u32>, Option<Vec<u8>>)> = c
            .query_row(
                "SELECT lifecycle,expires,last_seq FROM switches WHERE switch_id=?1",
                params![switch_id.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (lifecycle, expiry_height, sequence) = row.ok_or(KeeperError::NotFound)?;
        Ok(VaultState {
            lifecycle: parse_lifecycle(&lifecycle)?,
            expiry_height,
            last_sequence: sequence.as_deref().map(blob_u64).transpose()?,
        })
    }
    pub fn claim_delivery(&self, expected_cursor: Cursor) -> Result<Option<Delivery>> {
        let _gate = self
            .dispatch_gate
            .lock()
            .map_err(|_| KeeperError::Poisoned)?;
        if self.suspended.load(Ordering::Acquire) {
            return Err(KeeperError::Suspended);
        }
        let mut c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        let tx = c.transaction()?;
        if !healthy_tx(&tx)? {
            return Err(KeeperError::Suspended);
        }
        let cur = cursor_tx(&tx)?.ok_or(KeeperError::Suspended)?;
        if cur != expected_cursor {
            return Err(KeeperError::StaleCursor);
        }
        let row=tx.query_row("SELECT o.id,o.idempotency_key,o.switch_id,s.epoch,s.manifest,o.payload FROM outbox o JOIN switches s ON s.switch_id=o.switch_id WHERE o.status='PENDING' AND s.lifecycle='RELEASED' ORDER BY o.id LIMIT 1",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?,r.get::<_,u32>(3)?,r.get::<_,Vec<u8>>(4)?,r.get::<_,Vec<u8>>(5)?))).optional()?;
        let Some((id, key, sid, epoch, manifest, payload)) = row else {
            tx.commit()?;
            return Ok(None);
        };
        tx.execute(
            "UPDATE outbox SET attempts=attempts+1 WHERE id=?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(Some(Delivery {
            id,
            idempotency_key: key,
            switch_id: array32(&sid)?,
            epoch,
            manifest_digest: array32(&manifest)?,
            encrypted_share_envelope: payload,
            cursor: cur,
        }))
    }
    pub fn acknowledge_delivery(
        &self,
        id: i64,
        delivered: bool,
        expected_cursor: Cursor,
    ) -> Result<()> {
        let _gate = self
            .dispatch_gate
            .lock()
            .map_err(|_| KeeperError::Poisoned)?;
        if self.suspended.load(Ordering::Acquire) {
            return Err(KeeperError::Suspended);
        }
        let c = self.conn.lock().map_err(|_| KeeperError::Poisoned)?;
        if !healthy_conn(&c)? {
            return Err(KeeperError::Suspended);
        }
        if cursor_conn(&c)?.as_ref() != Some(&expected_cursor) {
            return Err(KeeperError::StaleCursor);
        }
        let status = if delivered { "DELIVERED" } else { "PENDING" };
        let n=c.execute("UPDATE outbox SET status=?1 WHERE id=?2 AND status='PENDING' AND EXISTS(SELECT 1 FROM switches s WHERE s.switch_id=outbox.switch_id AND s.lifecycle='RELEASED')",params![status,id])?;
        if n == 0 {
            return Err(KeeperError::NotFound);
        }
        Ok(())
    }
}

fn process_block(tx: &Transaction<'_>, network: u8, b: &ScannedBlock) -> Result<()> {
    for transaction in &b.transactions {
        for o in &transaction.outputs {
            if o.memo.starts_with(&[0xff, b'Z', b'C', b'A', b'N']) && o.memo.len() != 512 {
                return Err(KeeperError::Invalid(
                    "Z-CANARY memo must be exactly 512 bytes".into(),
                ));
            }
            if o.memo.len() != 512 || o.memo[0] != 0xff || &o.memo[1..5] != b"ZCAN" {
                continue;
            }
            let Ok(cmd) = decode_and_verify_memo(&o.memo, network) else {
                continue;
            };
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM switches WHERE switch_id=?1)",
                params![cmd.switch_id.as_slice()],
                |r| r.get(0),
            )?;
            if !exists {
                continue;
            }
            let rec: (Vec<u8>,Vec<u8>,Option<Vec<u8>>,String,Option<i64>,i64,i64)=tx.query_row("SELECT manifest,source,last_seq,lifecycle,expires,max_extension,initial_interval FROM switches WHERE switch_id=?1",params![cmd.switch_id.as_slice()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?;
            if rec.0 != cmd.manifest_digest || rec.1 != cmd.source_pubkey {
                continue;
            }
            if cmd.operation == Operation::Register {
                if cmd.sequence != 0 {
                    continue;
                }
                if rec.3 == "DRAFT" {
                    let expires = i64::from(cmd.requested_expiry_height);
                    let max_expiry = i64::from(b.height)
                        .checked_add(rec.6)
                        .ok_or_else(|| KeeperError::Invalid("expiry overflow".into()))?;
                    let grace = switch_grace(tx, &cmd.switch_id)?;
                    if cmd.requested_expiry_height.checked_add(grace).is_none()
                        || expires <= i64::from(b.height)
                        || expires > max_expiry
                    {
                        continue;
                    }
                    tx.execute("UPDATE switches SET registration_height=?1,expires=?2,last_seq=?3,lifecycle='ACTIVE' WHERE switch_id=?4 AND lifecycle='DRAFT'",params![b.height,expires,u64_blob(0).as_slice(),cmd.switch_id.as_slice()])?;
                }
                continue;
            }
            if rec.3 == "DRAFT" || rec.3 == "CANCELLED" || rec.3 == "RELEASED" {
                continue;
            }
            let boundary = rec
                .4
                .ok_or_else(|| KeeperError::Invalid("active switch has no expiry".into()))?
                .checked_add(i64::from(switch_grace(tx, &cmd.switch_id)?))
                .ok_or_else(|| KeeperError::Invalid("grace boundary overflow".into()))?;
            if i64::from(b.height) > boundary {
                continue;
            }
            let last =
                blob_u64(rec.2.as_deref().ok_or_else(|| {
                    KeeperError::Invalid("active switch has no sequence".into())
                })?)?;
            if cmd.sequence <= last {
                continue;
            }
            match cmd.operation {
                Operation::Cancel => {
                    if cmd.requested_expiry_height != 0 {
                        return Err(KeeperError::Invalid("cancel expiry must be zero".into()));
                    }
                    tx.execute(
                        "UPDATE switches SET lifecycle='CANCELLED',last_seq=?1 WHERE switch_id=?2",
                        params![u64_blob(cmd.sequence).as_slice(), cmd.switch_id.as_slice()],
                    )?;
                    tx.execute("UPDATE outbox SET status='SUPPRESSED' WHERE switch_id=?1 AND status='PENDING'",params![cmd.switch_id.as_slice()])?;
                }
                Operation::Postpone => {
                    let requested = i64::from(cmd.requested_expiry_height);
                    let max = i64::from(rec.5);
                    let expiry = rec.4.ok_or_else(|| {
                        KeeperError::Invalid("active switch has no expiry".into())
                    })?;
                    let upper = i64::from(b.height)
                        .checked_add(max)
                        .ok_or_else(|| KeeperError::Invalid("extension overflow".into()))?;
                    let grace = switch_grace(tx, &cmd.switch_id)?;
                    if cmd.requested_expiry_height.checked_add(grace).is_none()
                        || requested <= expiry
                        || requested > upper
                    {
                        continue;
                    }
                    tx.execute("UPDATE switches SET expires=?1,last_seq=?2,lifecycle='ACTIVE' WHERE switch_id=?3",params![requested,u64_blob(cmd.sequence).as_slice(),cmd.switch_id.as_slice()])?;
                }
                Operation::Register => unreachable!(),
            }
        }
    }
    Ok(())
}
fn validate_positions(ts: &[ScannedTransaction]) -> Result<()> {
    let mut prev = None;
    let mut txids = std::collections::HashSet::new();
    for t in ts {
        if prev.is_some_and(|p| t.tx_index <= p) || !txids.insert(t.txid) {
            return Err(KeeperError::Invalid(
                "transaction positions or IDs are duplicate or out of order".into(),
            ));
        }
        prev = Some(t.tx_index);
        let mut po = None;
        for o in &t.outputs {
            if po.is_some_and(|p| o.output_index <= p) || o.tx_index != t.tx_index {
                return Err(KeeperError::Invalid(
                    "output positions are duplicate, out of order, or mismatched".into(),
                ));
            }
            po = Some(o.output_index)
        }
    }
    Ok(())
}
fn switch_grace(tx: &Transaction<'_>, switch_id: &[u8; 32]) -> Result<u32> {
    Ok(tx.query_row(
        "SELECT grace FROM switches WHERE switch_id=?1",
        params![switch_id.as_slice()],
        |r| r.get(0),
    )?)
}
fn mark_grace(tx: &Transaction<'_>, height: u32) -> Result<()> {
    tx.execute("UPDATE switches SET lifecycle='GRACE' WHERE lifecycle='ACTIVE' AND expires IS NOT NULL AND ?1>=expires",params![height])?;
    Ok(())
}
fn release_due(tx: &Transaction<'_>, height: u32) -> Result<()> {
    let mut stmt=tx.prepare("SELECT switch_id,expires,grace,manifest,envelope,idempotency_key FROM switches WHERE lifecycle IN ('ACTIVE','GRACE') AND expires IS NOT NULL")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Vec<u8>>(3)?,
            r.get::<_, Vec<u8>>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    let mut due = Vec::new();
    for row in rows {
        let x = row?;
        let threshold =
            x.1.checked_add(x.2)
                .ok_or_else(|| KeeperError::Invalid("grace boundary overflow".into()))?;
        if i64::from(height) >= threshold {
            due.push(x)
        }
    }
    drop(stmt);
    for (sid, _exp, _grace, manifest, payload, key) in due {
        tx.execute("UPDATE switches SET lifecycle='RELEASED' WHERE switch_id=?1 AND lifecycle IN ('ACTIVE','GRACE')",params![sid.as_slice()])?;
        tx.execute("INSERT OR IGNORE INTO outbox(switch_id,idempotency_key,payload,status) VALUES(?1,?2,?3,'PENDING')",params![sid,key,payload])?;
        let _ = manifest;
    }
    Ok(())
}
fn cursor_conn(c: &Connection) -> Result<Option<Cursor>> {
    let h: Option<Vec<u8>> = c
        .query_row(
            "SELECT value FROM meta WHERE key='cursor_height'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let Some(h) = h else { return Ok(None) };
    let hash: Vec<u8> = c.query_row("SELECT value FROM meta WHERE key='cursor_hash'", [], |r| {
        r.get(0)
    })?;
    Ok(Some(Cursor {
        height: u32::from_be_bytes(
            h.try_into()
                .map_err(|_| KeeperError::Invalid("corrupt cursor height".into()))?,
        ),
        hash: array32(&hash)?,
    }))
}
fn cursor_tx(t: &Transaction<'_>) -> Result<Option<Cursor>> {
    cursor_conn(t)
}
fn healthy_conn(c: &Connection) -> Result<bool> {
    let v: Vec<u8> = c.query_row("SELECT value FROM meta WHERE key='healthy'", [], |r| {
        r.get(0)
    })?;
    let incident = reorg_incident_conn(c)?;
    Ok(v == [1] && !incident)
}
fn healthy_tx(t: &Transaction<'_>) -> Result<bool> {
    healthy_conn(t)
}
fn reorg_incident_conn(c: &Connection) -> Result<bool> {
    let v: Vec<u8> = c.query_row(
        "SELECT value FROM meta WHERE key='reorg_incident'",
        [],
        |r| r.get(0),
    )?;
    Ok(v == [1])
}
fn reorg_incident(t: &Transaction<'_>) -> Result<bool> {
    reorg_incident_conn(t)
}
fn suspend(t: &Transaction<'_>) -> Result<()> {
    t.execute("UPDATE meta SET value=x'00' WHERE key='healthy'", [])?;
    Ok(())
}
fn latch_reorg(t: &Transaction<'_>) -> Result<()> {
    suspend(t)?;
    t.execute("UPDATE meta SET value=x'01' WHERE key='reorg_incident'", [])?;
    Ok(())
}
fn delivery_key(s: &[u8; 32], epoch: u32, k: &str, m: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(b"ZCANARY-KEEPER-DELIVERY-V1");
    h.update(s);
    h.update(epoch.to_be_bytes());
    h.update((k.len() as u64).to_be_bytes());
    h.update(k.as_bytes());
    h.update(m);
    hex::encode(h.finalize())
}
fn u64_blob(v: u64) -> [u8; 8] {
    v.to_be_bytes()
}
fn blob_u64(v: &[u8]) -> Result<u64> {
    Ok(u64::from_be_bytes(v.try_into().map_err(|_| {
        KeeperError::Invalid("corrupt sequence".into())
    })?))
}
fn array32(v: &[u8]) -> Result<[u8; 32]> {
    v.try_into()
        .map_err(|_| KeeperError::Invalid("corrupt 32-byte value".into()))
}
fn parse_lifecycle(s: &str) -> Result<Lifecycle> {
    match s {
        "DRAFT" => Ok(Lifecycle::Draft),
        "ACTIVE" => Ok(Lifecycle::Active),
        "GRACE" => Ok(Lifecycle::Grace),
        "CANCELLED" => Ok(Lifecycle::Cancelled),
        "RELEASED" => Ok(Lifecycle::Released),
        _ => Err(KeeperError::Invalid("corrupt lifecycle".into())),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };
    use zcanary_core::encode_memo;

    fn db_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "zcanary-keeper-{tag}-{}-{}.sqlite",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn seed() -> [u8; 32] {
        [9; 32]
    }
    fn policy(conf: u32) -> Policy {
        Policy {
            initial_interval: 10,
            max_extension: 5,
            confirmation_count: conf,
            grace_period: 3,
        }
    }
    fn setup(path: &Path) -> Keeper {
        let k = Keeper::open(path, 1, "keeper-a").unwrap();
        k.provision(ProvisioningRecord {
            switch_id: [1; 32],
            manifest_digest: [2; 32],
            source_pubkey: SigningKey::from_bytes(&seed()).verifying_key().to_bytes(),
            epoch: 1,
            keeper_index: 1,
            policy: policy(2),
            encrypted_share_envelope: vec![7, 8, 9],
        })
        .unwrap();
        k
    }
    fn memo(
        switch_id: [u8; 32],
        digest: [u8; 32],
        op: Operation,
        sequence: u64,
        expiry: u32,
    ) -> Vec<u8> {
        encode_memo(
            &zcanary_core::Command {
                network: 1,
                operation: op,
                switch_id,
                sequence,
                requested_expiry_height: expiry,
                manifest_digest: digest,
                source_pubkey: SigningKey::from_bytes(&seed()).verifying_key().to_bytes(),
            },
            &seed(),
        )
        .unwrap()
        .to_vec()
    }
    fn main_memo(op: Operation, sequence: u64, expiry: u32) -> Vec<u8> {
        memo([1; 32], [2; 32], op, sequence, expiry)
    }
    fn with_memo(mut b: ScannedBlock, memo: Vec<u8>) -> ScannedBlock {
        b.transactions = vec![ScannedTransaction {
            txid: [4; 32],
            tx_index: 0,
            outputs: vec![ScannedOutput {
                tx_index: 0,
                output_index: 0,
                memo,
            }],
        }];
        b
    }
    fn blocks(start: u32, end: u32, previous: [u8; 32]) -> Vec<ScannedBlock> {
        let mut prev = previous;
        (start..=end)
            .map(|h| {
                let hash = [(h as u8).wrapping_add(1); 32];
                let b = ScannedBlock {
                    height: h,
                    hash,
                    previous_hash: prev,
                    transactions: vec![],
                };
                prev = hash;
                b
            })
            .collect()
    }
    fn batch(blocks: Vec<ScannedBlock>, through: u32, observed_tip: u32) -> ConfirmedBatch {
        ConfirmedBatch {
            blocks,
            confirmed_through: through,
            observed_tip_height: observed_tip,
        }
    }

    #[test]
    fn provisioned_draft_never_releases_even_past_candidate_deadline_and_survives_restart() {
        let path = db_path("draft");
        let k = setup(&path);
        k.process_confirmed_batch(batch(blocks(0, 40, [0; 32]), 40, 41))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Draft);
        drop(k);
        let reopened = Keeper::open_existing(&path, 1, "keeper-a").unwrap();
        assert_eq!(reopened.lifecycle([1; 32]).unwrap(), Lifecycle::Draft);
        assert_eq!(reopened.cursor().unwrap().unwrap().height, 40);
        drop(reopened);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn incomplete_mid_batch_is_prevalidated_before_register_or_block_writes() {
        let path = db_path("mid-gap");
        let k = setup(&path);
        let mut bs = blocks(0, 2, [0; 32]);
        bs[0] = with_memo(bs[0].clone(), main_memo(Operation::Register, 0, 10));
        bs.remove(1);
        assert!(matches!(
            k.process_confirmed_batch(batch(bs, 2, 3)),
            Err(KeeperError::IncompleteBatch)
        ));
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Draft);
        assert_eq!(k.cursor().unwrap(), None);
        assert!(!k.is_healthy().unwrap());
        let count: i64 = k
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn incomplete_initial_gap_suspends_without_advancing_cursor() {
        let path = db_path("gap");
        let k = Keeper::open(&path, 1, "keeper-a").unwrap();
        assert!(matches!(
            k.process_confirmed_batch(batch(blocks(1, 1, [0; 32]), 1, 2)),
            Err(KeeperError::IncompleteBatch)
        ));
        assert!(!k.is_healthy().unwrap());
        assert_eq!(k.cursor().unwrap(), None);
        drop(k);
        let r = Keeper::open_existing(&path, 1, "keeper-a");
        assert!(r.is_err());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn reorg_incident_latches_even_when_old_branch_is_retried() {
        let path = db_path("reorg");
        let k = Keeper::open(&path, 1, "keeper-a").unwrap();
        let c = k
            .process_confirmed_batch(batch(blocks(0, 0, [0; 32]), 0, 1))
            .unwrap();
        assert!(matches!(
            k.process_confirmed_batch(batch(blocks(1, 1, [99; 32]), 1, 2)),
            Err(KeeperError::ReorgIncident)
        ));
        assert_eq!(k.cursor().unwrap().unwrap(), c);
        assert!(!k.is_healthy().unwrap());
        assert!(matches!(
            k.claim_delivery(c.clone()),
            Err(KeeperError::Suspended)
        ));
        assert!(matches!(
            k.process_confirmed_batch(batch(blocks(1, 1, c.hash), 1, 2)),
            Err(KeeperError::ReorgIncident)
        ));
        assert_eq!(k.cursor().unwrap().unwrap(), c);
        assert!(!k.is_healthy().unwrap());
        drop(k);
        let reopened = Keeper::open_existing(&path, 1, "keeper-a").unwrap();
        assert!(matches!(
            reopened.process_confirmed_batch(batch(blocks(1, 1, c.hash), 1, 2)),
            Err(KeeperError::ReorgIncident)
        ));
        assert!(!reopened.is_healthy().unwrap());
        drop(reopened);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn trusted_checkpoint_initializes_once_and_existing_open_preserves_cursor() {
        let path = db_path("checkpoint");
        let anchor = Cursor {
            height: 700,
            hash: [70; 32],
        };
        let k = Keeper::open_at_checkpoint(&path, 1, "keeper-a", anchor.clone()).unwrap();
        let c = k
            .process_confirmed_batch(batch(blocks(701, 701, anchor.hash), 701, 701))
            .unwrap();
        assert!(matches!(
            Keeper::open_at_checkpoint(&path, 1, "keeper-a", anchor),
            Err(KeeperError::AlreadyInitialized)
        ));
        drop(k);
        let reopened = Keeper::open_existing(&path, 1, "keeper-a").unwrap();
        assert_eq!(reopened.cursor().unwrap().unwrap(), c);
        drop(reopened);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn heterogeneous_confirmation_policies_gate_coverage_by_largest_target() {
        let path = db_path("confirmations");
        let k = setup(&path);
        k.provision(ProvisioningRecord {
            switch_id: [5; 32],
            manifest_digest: [6; 32],
            source_pubkey: SigningKey::from_bytes(&seed()).verifying_key().to_bytes(),
            epoch: 5,
            keeper_index: 2,
            policy: policy(5),
            encrypted_share_envelope: vec![5],
        })
        .unwrap();
        let bs = blocks(0, 0, [0; 32]);
        assert!(matches!(
            k.process_confirmed_batch(batch(bs.clone(), 0, 3)),
            Err(KeeperError::InsufficientConfirmations)
        ));
        assert_eq!(k.cursor().unwrap(), None);
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Draft);
        assert!(!k.is_healthy().unwrap());
        k.process_confirmed_batch(batch(bs, 0, 4)).unwrap();
        assert!(k.is_healthy().unwrap());
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn invalid_provisioning_epoch_or_keeper_index_is_rejected() {
        let path = db_path("invalid-provision");
        let k = Keeper::open(&path, 1, "keeper-a").unwrap();
        let base = ProvisioningRecord {
            switch_id: [1; 32],
            manifest_digest: [2; 32],
            source_pubkey: SigningKey::from_bytes(&seed()).verifying_key().to_bytes(),
            epoch: 1,
            keeper_index: 0,
            policy: policy(1),
            encrypted_share_envelope: vec![1],
        };
        assert!(matches!(
            k.provision(base.clone()),
            Err(KeeperError::Invalid(_))
        ));
        let mut bad = base;
        bad.keeper_index = 1;
        bad.epoch = 0;
        assert!(matches!(k.provision(bad), Err(KeeperError::Invalid(_))));
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn identical_provision_retry_keeps_first_recipient_envelope_and_rejects_metadata_change() {
        let path = db_path("provision-retry");
        let k = Keeper::open(&path, 1, "keeper-a").unwrap();
        let source = SigningKey::from_bytes(&seed()).verifying_key().to_bytes();
        let initial = ProvisioningRecord {
            switch_id: [31; 32],
            manifest_digest: [32; 32],
            source_pubkey: source,
            epoch: 7,
            keeper_index: 2,
            policy: policy(3),
            encrypted_share_envelope: vec![1, 2, 3],
        };
        k.provision(initial.clone()).unwrap();
        let mut retry = initial.clone();
        retry.encrypted_share_envelope = vec![9, 8, 7];
        k.provision(retry).unwrap();
        let stored: Vec<u8> = k
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT envelope FROM switches WHERE switch_id=?1",
                params![initial.switch_id.as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, initial.encrypted_share_envelope);

        let mut conflict = initial;
        conflict.manifest_digest = [33; 32];
        assert!(matches!(
            k.provision(conflict),
            Err(KeeperError::Invalid(_))
        ));
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn expiry_plus_grace_overflow_is_rejected_for_register_and_postpone() {
        let path = db_path("deadline-overflow");
        let k = Keeper::open(&path, 1, "keeper-a").unwrap();
        let source = SigningKey::from_bytes(&seed()).verifying_key().to_bytes();
        k.provision(ProvisioningRecord {
            switch_id: [7; 32],
            manifest_digest: [8; 32],
            source_pubkey: source,
            epoch: 7,
            keeper_index: 1,
            policy: Policy {
                initial_interval: 20,
                max_extension: u32::MAX,
                confirmation_count: 1,
                grace_period: 3,
            },
            encrypted_share_envelope: vec![1],
        })
        .unwrap();
        k.provision(ProvisioningRecord {
            switch_id: [9; 32],
            manifest_digest: [10; 32],
            source_pubkey: source,
            epoch: 8,
            keeper_index: 2,
            policy: Policy {
                initial_interval: u32::MAX,
                max_extension: 5,
                confirmation_count: 1,
                grace_period: 3,
            },
            encrypted_share_envelope: vec![1],
        })
        .unwrap();
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(
            first[0].clone(),
            memo([7; 32], [8; 32], Operation::Register, 0, 10),
        );
        first[0].transactions.push(ScannedTransaction {
            txid: [5; 32],
            tx_index: 1,
            outputs: vec![ScannedOutput {
                tx_index: 1,
                output_index: 0,
                memo: memo([9; 32], [10; 32], Operation::Register, 0, u32::MAX),
            }],
        });
        let c = k.process_confirmed_batch(batch(first, 0, 0)).unwrap();
        assert_eq!(k.lifecycle([7; 32]).unwrap(), Lifecycle::Active);
        assert_eq!(k.lifecycle([9; 32]).unwrap(), Lifecycle::Draft);
        let mut next = blocks(1, 10, c.hash);
        next[9] = with_memo(
            next[9].clone(),
            memo([7; 32], [8; 32], Operation::Postpone, 1, u32::MAX),
        );
        k.process_confirmed_batch(batch(next, 10, 10)).unwrap();
        let expiry: i64 = k
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT expires FROM switches WHERE switch_id=?1",
                params![[7u8; 32].as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(expiry, 10);
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn u64_sequences_and_epochs_roundtrip_above_sqlite_integer_range() {
        let n = u64::MAX;
        assert_eq!(blob_u64(&u64_blob(n)).unwrap(), n);
        let k1 = delivery_key(&[1; 32], 1, "keeper-a", &[2; 32]);
        assert_eq!(k1, delivery_key(&[1; 32], 1, "keeper-a", &[2; 32]));
    }
    #[test]
    fn release_occurs_at_expiry_plus_inclusive_grace_after_boundary_commands() {
        let path = db_path("exact-release");
        let k = setup(&path);
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let c = k
            .process_confirmed_batch(batch(blocks(1, 12, c.hash), 12, 13))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Grace);
        assert!(k.claim_delivery(c.clone()).unwrap().is_none());
        let c = k
            .process_confirmed_batch(batch(blocks(13, 13, c.hash), 13, 14))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);
        assert!(k.claim_delivery(c).unwrap().is_some());
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn cancellation_in_last_inclusive_grace_block_suppresses_release() {
        let path = db_path("cancel");
        let k = setup(&path);
        let mut bs = blocks(0, 13, [0; 32]);
        bs[0] = with_memo(bs[0].clone(), main_memo(Operation::Register, 0, 10));
        bs[13] = with_memo(bs[13].clone(), main_memo(Operation::Cancel, 1, 0));
        k.process_confirmed_batch(batch(bs, 13, 14)).unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Cancelled);
        let c = k.cursor().unwrap().unwrap();
        assert_eq!(k.claim_delivery(c).unwrap(), None);
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn postpone_in_last_grace_block_wins_and_outbox_retries_keep_stable_key() {
        let path = db_path("postpone");
        let k = setup(&path);
        assert_eq!(
            k.vault_state([1; 32]).unwrap(),
            VaultState {
                lifecycle: Lifecycle::Draft,
                expiry_height: None,
                last_sequence: None
            }
        );
        assert!(matches!(k.vault_state([9; 32]), Err(KeeperError::NotFound)));
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c0 = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let mut through_grace = blocks(1, 13, c0.hash);
        through_grace[12] = with_memo(
            through_grace[12].clone(),
            main_memo(Operation::Postpone, u64::MAX, 15),
        );
        let c = k
            .process_confirmed_batch(batch(through_grace, 13, 14))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Active);
        assert_eq!(
            k.vault_state([1; 32]).unwrap(),
            VaultState {
                lifecycle: Lifecycle::Active,
                expiry_height: Some(15),
                last_sequence: Some(u64::MAX)
            }
        );
        assert!(k.claim_delivery(c.clone()).unwrap().is_none());
        let c = k
            .process_confirmed_batch(batch(blocks(14, 18, c.hash), 18, 19))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);
        let stored_seq: Vec<u8> = k
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT last_seq FROM switches WHERE switch_id=?1",
                params![[1u8; 32].as_slice()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blob_u64(&stored_seq).unwrap(), u64::MAX);
        assert!(matches!(
            k.claim_delivery(c0),
            Err(KeeperError::StaleCursor)
        ));
        let d1 = k.claim_delivery(c.clone()).unwrap().unwrap();
        k.acknowledge_delivery(d1.id, false, c.clone()).unwrap();
        let d2 = k.claim_delivery(c.clone()).unwrap().unwrap();
        assert_eq!(d1.idempotency_key, d2.idempotency_key);
        assert_eq!(d2.encrypted_share_envelope, vec![7, 8, 9]);
        k.acknowledge_delivery(d2.id, true, c.clone()).unwrap();
        assert!(k.claim_delivery(c).unwrap().is_none());
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn late_command_does_not_block_cursor_or_release() {
        let path = db_path("late");
        let k = setup(&path);
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let mut bs = blocks(1, 14, c.hash);
        bs[13] = with_memo(bs[13].clone(), main_memo(Operation::Postpone, 1, 15));
        let end = k.process_confirmed_batch(batch(bs, 14, 15)).unwrap();
        assert_eq!(end.height, 14);
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);
        assert!(k.claim_delivery(end).unwrap().is_some());
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn cancellation_after_release_does_not_recall_pending_envelope() {
        let path = db_path("no-recall");
        let k = setup(&path);
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let c = k
            .process_confirmed_batch(batch(blocks(1, 13, c.hash), 13, 14))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);
        let mut bs = blocks(14, 14, c.hash);
        bs[0] = with_memo(bs[0].clone(), main_memo(Operation::Cancel, 1, 0));
        let end = k.process_confirmed_batch(batch(bs, 14, 15)).unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);
        assert!(k.claim_delivery(end).unwrap().is_some());
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn rejected_batch_rolls_back_and_suspends_pending_delivery() {
        let path = db_path("rejected-pending");
        let k = setup(&path);
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let c = k
            .process_confirmed_batch(batch(blocks(1, 13, c.hash), 13, 14))
            .unwrap();
        assert_eq!(k.lifecycle([1; 32]).unwrap(), Lifecycle::Released);

        let mut malformed = blocks(14, 14, c.hash);
        malformed[0] = with_memo(malformed[0].clone(), vec![0xff, b'Z', b'C', b'A', b'N']);
        assert!(matches!(
            k.process_confirmed_batch(batch(malformed, 14, 15)),
            Err(KeeperError::Invalid(_))
        ));
        assert_eq!(k.cursor().unwrap().unwrap(), c);
        assert!(!k.is_healthy().unwrap());
        assert!(matches!(k.claim_delivery(c), Err(KeeperError::Suspended)));
        drop(k);
        let _ = fs::remove_file(path);
    }
    #[test]
    fn restart_requires_fresh_complete_scan_before_pending_delivery() {
        let path = db_path("restart-delivery");
        let k = setup(&path);
        let mut first = blocks(0, 0, [0; 32]);
        first[0] = with_memo(first[0].clone(), main_memo(Operation::Register, 0, 10));
        let c = k.process_confirmed_batch(batch(first, 0, 1)).unwrap();
        let cursor = k
            .process_confirmed_batch(batch(blocks(1, 13, c.hash), 13, 14))
            .unwrap();
        drop(k);

        let reopened = Keeper::open_existing(&path, 1, "keeper-a").unwrap();
        assert!(!reopened.is_healthy().unwrap());
        assert!(matches!(
            reopened.claim_delivery(cursor.clone()),
            Err(KeeperError::Suspended)
        ));
        let fresh = reopened
            .process_confirmed_batch(batch(blocks(14, 14, cursor.hash), 14, 15))
            .unwrap();
        assert!(reopened.is_healthy().unwrap());
        assert!(reopened.claim_delivery(fresh).unwrap().is_some());
        drop(reopened);
        let _ = fs::remove_file(path);
    }
}
