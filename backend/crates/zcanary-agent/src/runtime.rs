//! Local testnet orchestration. Spending keys remain in the wallet process;
//! each keeper scanner receives only an encrypted UFVK capability.
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub state_dir: PathBuf,
    pub wallet_state_dir: PathBuf,
    pub wallet_executable: PathBuf,
    pub vault_executable: PathBuf,
    pub keeper_executable: PathBuf,
    pub dpapi_script: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vault {
    id: String,
    file_name: String,
    manifest: Value,
    provisions: Vec<Value>,
    package_path: PathBuf,
    keeper_recipients: Vec<String>,
    acknowledgements: Vec<Value>,
    deliveries: BTreeMap<String, Value>,
    events: Vec<Value>,
    last_operation: Option<String>,
    last_expiry: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    operation_id: String,
    vault_id: String,
    action: String,
    expiry_height: u32,
    state: String,
    txid: Option<String>,
    block_height: Option<u32>,
    error: Option<String>,
    memo_hex: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Data {
    vaults: BTreeMap<String, Vault>,
    operations: BTreeMap<String, Operation>,
}
struct Connection {
    id: String,
    address: SocketAddr,
    token: String,
    public: Value,
}
pub struct Runtime {
    config: RuntimeConfig,
    data: Mutex<Data>,
    keepers: Vec<Connection>,
    children: Mutex<Vec<Child>>,
    wallet_lock: Mutex<()>,
    source_lock: Mutex<()>,
    recipient_lock: Mutex<()>,
    scan_lock: Mutex<Option<(String, std::time::Instant, Value)>>,
    stop: AtomicBool,
    wallet_public: Value,
    _lock: File,
}

impl Runtime {
    pub fn start(path: &Path) -> Result<Arc<Self>> {
        let config: RuntimeConfig = serde_json::from_slice(&read_bounded(path, 32 * 1024)?)?;
        for p in [
            &config.state_dir,
            &config.wallet_state_dir,
            &config.wallet_executable,
            &config.vault_executable,
            &config.keeper_executable,
            &config.dpapi_script,
        ] {
            ensure!(p.is_absolute(), "runtime paths must be absolute");
        }
        fs::create_dir_all(&config.state_dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(config.state_dir.join("runtime.lock"))?;
        lock.try_lock()
            .context("another native runtime is using this state")?;
        let secret_path = config.state_dir.join("runtime-secret.dpapi");
        ensure!(
            secret_path.exists() || !config.state_dir.join("control.dpapi").exists(),
            "runtime secret is missing for existing state"
        );
        let secret = if secret_path.exists() {
            Zeroizing::new(unprotect(&config, &fs::read(&secret_path)?)?)
        } else {
            let mut secret = Zeroizing::new(vec![0; 32]);
            getrandom::fill(&mut secret)
                .map_err(|_| anyhow::anyhow!("secure random unavailable"))?;
            write_atomic(&secret_path, &protect(&config, &secret)?)?;
            secret
        };
        ensure!(secret.len() == 32, "invalid runtime secret");
        let data_path = config.state_dir.join("control.dpapi");
        let data = if data_path.exists() {
            let clear = Zeroizing::new(unprotect(
                &config,
                &read_bounded(&data_path, 16 * 1024 * 1024)?,
            )?);
            serde_json::from_slice(&clear)?
        } else {
            Data::default()
        };
        let wallet_public = wallet_json(&config, &["status".into()])?;
        ensure!(
            wallet_public["network"] == "testnet",
            "wallet is not on testnet"
        );
        let viewer = config.state_dir.join("registry-viewer.dpapi");
        let checkpoint_path = config.state_dir.join("registry-checkpoint.json");
        let checkpoint = if viewer.exists() {
            serde_json::from_slice(&read_bounded(&checkpoint_path, 8192)?)
                .context("existing viewer checkpoint metadata missing or invalid")?
        } else {
            ensure!(
                !checkpoint_path.exists(),
                "viewer capability is missing for existing checkpoint"
            );
            let checkpoint = wallet_json(
                &config,
                &[
                    "export-viewer".into(),
                    viewer.to_string_lossy().into_owned(),
                ],
            )?;
            write_atomic(&checkpoint_path, &serde_json::to_vec(&checkpoint)?)?;
            checkpoint
        };
        ensure!(
            checkpoint["network"] == "testnet",
            "viewer checkpoint is not testnet"
        );
        let height = checkpoint["checkpoint_height"]
            .as_u64()
            .context("viewer checkpoint height missing")?;
        let hash = checkpoint["checkpoint_hash"]
            .as_str()
            .context("viewer checkpoint hash missing")?;
        let mut keepers = Vec::new();
        let mut children = Vec::new();
        let startup = (|| -> Result<()> {
            for index in 1..=5 {
                let id = format!("keeper-{index:02}");
                let address = TcpListener::bind("127.0.0.1:0")?.local_addr()?;
                let token =
                    hex::encode(Sha256::digest([secret.as_slice(), id.as_bytes()].concat()));
                let passphrase = hex::encode(Sha256::digest(
                    [secret.as_slice(), b"keeper-identity-passphrase"].concat(),
                ));
                let mut command = hidden_command(&config.keeper_executable);
                command.args([
                    "--db",
                    config
                        .state_dir
                        .join(format!("{id}.sqlite"))
                        .to_str()
                        .context("state path encoding")?,
                    "--keeper-id",
                    &id,
                    "--network",
                    "1",
                    "--listen",
                    &address.to_string(),
                    "--mode",
                    "testnet-chain",
                    "--checkpoint-height",
                    &height.to_string(),
                    "--checkpoint-hash",
                    hash,
                ]);
                command
                    .env("ZCANARY_KEEPER_TOKEN", &token)
                    .env("ZCANARY_IDENTITY_PASSPHRASE", passphrase)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                children.push(command.spawn().context("start keeper process")?);
                let mut connection = Connection {
                    id,
                    address,
                    token,
                    public: Value::Null,
                };
                let mut ready = false;
                for _ in 0..180 {
                    if children.last_mut().unwrap().try_wait()?.is_some() {
                        bail!("keeper process could not start");
                    }
                    if let Ok(status) = keeper_request(&connection, "GET", "/v1/status", None) {
                        connection.public = status;
                        ready = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                ensure!(ready, "keeper startup timed out");
                ensure!(
                    connection.public["mode"] == "testnet-chain"
                        && connection.public["keeper_id"] == connection.id,
                    "keeper identity mismatch"
                );
                keepers.push(connection);
            }
            Ok(())
        })();
        if let Err(error) = startup {
            for child in &mut children {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(error);
        }
        let runtime = Arc::new(Self {
            config,
            data: Mutex::new(data),
            keepers,
            children: Mutex::new(children),
            wallet_lock: Mutex::new(()),
            source_lock: Mutex::new(()),
            recipient_lock: Mutex::new(()),
            scan_lock: Mutex::new(None),
            stop: AtomicBool::new(false),
            wallet_public,
            _lock: lock,
        });
        for index in 0..5 {
            let rt = runtime.clone();
            thread::spawn(move || rt.watch(index));
        }
        // Persisted operations resume through the wallet's immutable per-memo journal.
        let pending: Vec<String> = runtime
            .data
            .lock()
            .unwrap()
            .operations
            .values()
            .filter(|o| o.state == "submitted" || o.state == "broadcast")
            .map(|o| o.operation_id.clone())
            .collect();
        for id in pending {
            let rt = runtime.clone();
            thread::spawn(move || rt.execute_operation(id));
        }
        Ok(runtime)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut children) = self.children.lock() {
            for child in children.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        // Do not report shutdown while an existing spend may still be broadcasting.
        // Let its immutable journal settle; queued operations observe the stop flag.
        let _wallet = self.wallet_lock.lock().unwrap();
    }
    fn persist(&self, data: &Data) -> Result<()> {
        let clear = Zeroizing::new(serde_json::to_vec(data)?);
        write_atomic(
            &self.config.state_dir.join("control.dpapi"),
            &protect(&self.config, &clear)?,
        )
    }
    pub fn status(&self) -> Value {
        let running=!self.stop.load(Ordering::Acquire);
        let keepers:Vec<Value>=self.keepers.iter().map(|k|{let status=keeper_request(k,"GET","/v1/status",None).ok();json!({"id":k.id,"healthy":status.as_ref().and_then(|v|v["healthy"].as_bool()).unwrap_or(false),"cursor":status.map(|v|v["cursor"].clone())})}).collect();
            json!({"available":running,"mode":"testnet","wallet":{"available":running,"state":if running {"ready"}else{"stopped"}},"keepers":keepers})
    }
    pub fn fee_estimate(&self) -> Result<Value> {
        ensure!(!self.stop.load(Ordering::Acquire), "runtime stopped");
        let _wallet = self.wallet_lock.try_lock().map_err(|_| anyhow::anyhow!("wallet is busy"))?;
        let estimate = wallet_json(&self.config, &["estimate-command".into()])?;
        ensure!(estimate["network"] == "testnet", "fee estimate is not testnet");
        let fee = estimate["feeZatoshi"].as_u64().context("wallet fee missing")?;
        let note = estimate["noteAmountZatoshi"].as_u64().context("command note amount missing")?;
        let total = estimate["totalZatoshi"].as_u64().context("wallet total missing")?;
        let spendable = estimate["spendableZatoshi"].as_u64().context("wallet spendable amount missing")?;
        ensure!(note == 10_000 && fee.checked_add(note) == Some(total), "wallet estimate does not match a command proposal");
        Ok(json!({"network":"testnet","feeZatoshi":fee,"noteAmountZatoshi":note,"totalZatoshi":total,"spendableZatoshi":spendable}))
    }
    pub fn support(&self) -> Result<Value> {
        let address = self.wallet_public["receiveAddress"]
            .as_str()
            .context("wallet receive address missing")?;
        ensure!(
            address.starts_with("utest1"),
            "not a testnet unified address"
        );
        Ok(
            json!({"network":"testnet","address":address,"uri":format!("zcash:{address}?amount=0.00100000"),"amountZatoshi":100000,"memo":null}),
        )
    }
    pub fn recipient(&self) -> Result<Value> {
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        let _guard = self.recipient_lock.lock().unwrap();
        vault_json(&self.config, "recipient", "init-recipient", &json!({}))
    }
    pub fn identity_backup(&self, role: &str, action: &str, mut request: Value) -> Result<Value> {
        let result = (|| -> Result<Value> {
            ensure!(!self.stop.load(Ordering::Acquire), "runtime stopped");
            ensure!(["source", "recipient"].contains(&role) && ["export", "import"].contains(&action), "invalid identity backup operation");
            let _guard = if role == "source" { self.source_lock.lock().unwrap() } else { self.recipient_lock.lock().unwrap() };
            if action == "import" && !self.data.lock().unwrap().vaults.is_empty() {
                ensure!(self.config.state_dir.join(role).join(format!("{role}.identity.dpapi")).is_file(), "existing vault state requires its existing identity; key-only replacement is prohibited");
            }
            request["role"] = json!(role);
            vault_json(&self.config, role, &format!("{action}-identity"), &request)
        })();
        if let Some(Value::String(passphrase)) = request.get_mut("passphrase") {
            use zeroize::Zeroize;
            passphrase.zeroize();
        }
        result
    }
    pub fn create(&self, mut request: Value) -> Result<Value> {
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        let _guard = self.source_lock.lock().unwrap();
        let recipient = request["recipient"]
            .as_str()
            .context("recipient required")?;
        let full = zcanary_crypto::recipient_fingerprint(recipient)?;
        let fingerprint = full[..16]
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        ensure!(
            request["recipientFingerprint"] == fingerprint,
            "recipient fingerprint acknowledgement mismatch"
        );
        let interval = request["intervalBlocks"]
            .as_u64()
            .context("interval required")?;
        let confirmations = request["confirmationTarget"]
            .as_u64()
            .context("confirmation target required")?;
        ensure!(
            (2..=20).contains(&confirmations) && (8..=1_000_000).contains(&interval),
            "invalid testnet timing policy"
        );
        let recipients: Vec<String> = self
            .keepers
            .iter()
            .map(|k| k.public["recipient"].as_str().unwrap().to_owned())
            .collect();
        request["keeperRecipients"] = json!(recipients);
        request["maxExtensionBlocks"] = json!(interval.max(1000) * 4);
        let name = request["fileName"]
            .as_str()
            .context("file name required")?
            .to_owned();
        let result = vault_json(&self.config, "source", "create", &request);
        if let Some(Value::String(contents)) = request.get_mut("contentsBase64") {
            use zeroize::Zeroize;
            contents.zeroize();
        }
        let output = result?;
        let id = output["id"]
            .as_str()
            .context("vault identifier missing")?
            .to_owned();
        checked_hex(&id, 64)?;
        let vault = Vault {
            id: id.clone(),
            file_name: name,
            manifest: output["manifest"].clone(),
            provisions: serde_json::from_value(output["provisions"].clone())?,
            package_path: PathBuf::from(
                output["packagePath"]
                    .as_str()
                    .context("package path missing")?,
            ),
            keeper_recipients: recipients,
            acknowledgements: vec![],
            deliveries: BTreeMap::new(),
            events: vec![json!({"type":"encrypted","message":"Package encrypted locally"})],
            last_operation: None,
            last_expiry: None,
        };
        {
            let mut data = self.data.lock().unwrap();
            ensure!(!data.vaults.contains_key(&id), "duplicate vault identifier");
            data.vaults.insert(id.clone(), vault);
            self.persist(&data)?;
        }
        self.provision(&id)?;
        self.detail(&id)
    }
    pub fn provision(&self, id: &str) -> Result<()> {
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        let vault = self
            .data
            .lock()
            .unwrap()
            .vaults
            .get(id)
            .cloned()
            .context("vault not found")?;
        for (index, keeper) in self.keepers.iter().enumerate() {
            let provision = &vault.provisions[index];
            let ack = keeper_request(keeper, "POST", "/v1/provision", Some(provision))?;
            verify_ack(keeper, provision, &ack)?;
            let mut data = self.data.lock().unwrap();
            let stored = data.vaults.get_mut(id).context("vault missing")?;
            if !stored
                .acknowledgements
                .iter()
                .any(|a| a["keeperId"] == keeper.id)
            {
                stored.acknowledgements.push(json!({"keeperId":keeper.id,"verified":true,"signatureHex":ack["signature_hex"]}));
            }
            self.persist(&data)?;
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Value> {
        let ids: Vec<String> = self.data.lock().unwrap().vaults.keys().cloned().collect();
        let mut vaults = Vec::new();
        for id in ids {
            vaults.push(self.detail(&id)?);
        }
        Ok(json!({"vaults":vaults}))
    }
    pub fn detail(&self, id: &str) -> Result<Value> {
        checked_hex(id, 64)?;
        let data = self.data.lock().unwrap();
        let vault = data.vaults.get(id).context("vault not found")?.clone();
        let operation = vault
            .last_operation
            .as_ref()
            .and_then(|id| data.operations.get(id))
            .map(operation_public);
        drop(data);
        let states: Vec<Value> = self
            .keepers
            .iter()
            .filter_map(|k| {
                keeper_request(k, "GET", &format!("/v1/vaults/{id}"), None)
                    .ok()
                    .filter(|s|s["lifecycle"].is_string())
            })
            .collect();
        let agreement=states.len()>=3 && states.iter().all(|s|s["lifecycle"]==states[0]["lifecycle"] && s["expiry_height"]==states[0]["expiry_height"] && s["last_sequence"]==states[0]["last_sequence"]);
        let lifecycle = if agreement {
            states[0]["lifecycle"].as_str().unwrap().to_owned()
        } else {
            "SYNCING".into()
        };
        let expiry=if agreement{states[0]["expiry_height"].as_str().and_then(|s|s.parse::<u32>().ok())}else{None};
        let sequence=if agreement{states[0]["last_sequence"].as_str()}else{None};
        Ok(
            json!({"id":vault.id,"fileName":vault.file_name,"lifecycle":lifecycle,"manifest":vault.manifest,"acknowledgements":vault.acknowledgements,"shareCount":vault.deliveries.len(),"events":vault.events,"lastOperation":operation,"expiryHeight":expiry,"requestedExpiryHeight":vault.last_expiry,"keeperLastSequence":sequence,"keeperAgreement":if agreement{states.len()}else{0}}),
        )
    }
    pub fn events(&self, id: &str) -> Result<Value> {
        checked_hex(id, 64)?;
        let data = self.data.lock().unwrap();
        let vault = data.vaults.get(id).context("vault not found")?;
        Ok(json!({"events":vault.events}))
    }
    pub fn package(&self, id: &str) -> Result<Value> {
        checked_hex(id, 64)?;
        let vault = self.data.lock().unwrap().vaults.get(id).cloned().context("vault not found")?;
        ensure!(vault.manifest["switchIdHex"] == id, "vault manifest identifier mismatch");
        let source = self.config.state_dir.join("source").canonicalize()?;
        let path = vault.package_path.canonicalize()?;
        ensure!(path.starts_with(source), "package path outside source state");
        let bytes = read_bounded(&path, 10 * 1024 * 1024 + 65536)?;
        package_export(&vault.manifest, &bytes)
    }
    pub fn operation(&self, id: &str) -> Result<Value> {
        checked_hex(id, 32)?;
        let data = self.data.lock().unwrap();
        Ok(operation_public(
            data.operations.get(id).context("operation not found")?,
        ))
    }
    pub fn submit(self: &Arc<Self>, id: &str, action: &str) -> Result<Value> {
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        checked_hex(id, 64)?;
        ensure!(
            ["register", "postpone", "cancel"].contains(&action),
            "unknown command"
        );
        let vault = self
            .data
            .lock()
            .unwrap()
            .vaults
            .get(id)
            .cloned()
            .context("vault not found")?;
        ensure!(
            vault.acknowledgements.len() == 5,
            "all five keeper acknowledgements are required"
        );
        let detail = self.detail(id)?;
        let lifecycle = detail["lifecycle"].as_str().unwrap_or("SYNCING");
        ensure!(
            !["CANCELLED", "RELEASED"].contains(&lifecycle),
            "vault is terminal"
        );
        if action == "register" {
            ensure!(lifecycle == "DRAFT", "vault is already registered");
        } else {
            ensure!(
                ["ACTIVE", "GRACE"].contains(&lifecycle),
                "confirmed active or grace state required"
            );
        }
        let id_op = random_id()?;
        {
            let mut data = self.data.lock().unwrap();
            ensure!(
                !data.operations.values().any(|o| o.vault_id == id
                    && (o.state == "submitted" || o.state == "broadcast" || o.state == "failed")),
                "resume the existing command before submitting another"
            );
            let op = Operation {
                operation_id: id_op.clone(),
                vault_id: id.into(),
                action: action.into(),
                expiry_height: 0,
                state: "submitted".into(),
                txid: None,
                block_height: None,
                error: None,
                memo_hex: None,
            };
            data.operations.insert(id_op.clone(), op);
            data.vaults.get_mut(id).unwrap().last_operation = Some(id_op.clone());
            self.persist(&data)?;
        }
        let runtime = self.clone();
        let queued = id_op.clone();
        thread::spawn(move || runtime.execute_operation(queued));
        Ok(json!({"operationId":id_op}))
    }
    /// Resume the same persisted command. The wallet refuses to resend an ambiguous journal.
    pub fn retry(self: &Arc<Self>, id: &str) -> Result<Value> {
        checked_hex(id, 32)?;
        ensure!(!self.stop.load(Ordering::Acquire), "runtime stopped");
        {
            let mut data = self.data.lock().unwrap();
            let op = data.operations.get_mut(id).context("operation not found")?;
            ensure!(
                op.state == "failed",
                "only a failed operation can be resumed"
            );
            op.state = "submitted".into();
            op.error = None;
            self.persist(&data)?;
        }
        let runtime = self.clone();
        let queued = id.to_owned();
        thread::spawn(move || runtime.execute_operation(queued));
        Ok(json!({"operationId":id}))
    }
    fn execute_operation(self: Arc<Self>, id: String) {
        let result = (|| -> Result<()> {
            let _wallet = self.wallet_lock.lock().unwrap();
            ensure!(!self.stop.load(Ordering::Acquire), "runtime stopped");
            let mut op = self
                .data
                .lock()
                .unwrap()
                .operations
                .get(&id)
                .cloned()
                .context("operation missing")?;
            if op.memo_hex.is_none() {
                if op.expiry_height == 0 && op.action != "cancel" {
                    let status = wallet_json(&self.config, &["checkpoint".into(), "2".into()])?;
                    let tip = status["observed_tip_height"]
                        .as_u64()
                        .context("wallet tip missing")?;
                    let vault = self.data.lock().unwrap().vaults[&op.vault_id].clone();
                    let interval = vault.manifest["initialIntervalBlocks"]
                        .as_u64()
                        .context("interval missing")?;
                    op.expiry_height = u32::try_from(
                        (tip + interval).max(u64::from(vault.last_expiry.unwrap_or(0)) + 1),
                    )?;
                    let mut data = self.data.lock().unwrap();
                    data.operations.insert(id.clone(), op.clone());
                    self.persist(&data)?;
                }
                let _source = self.source_lock.lock().unwrap();
                let command = vault_json(
                    &self.config,
                    "source",
                    "command",
                    &json!({"id":op.vault_id,"operationId":op.operation_id,"operation":op.action,"expiryHeight":op.expiry_height}),
                )?;
                op.memo_hex = Some(
                    command["memoHex"]
                        .as_str()
                        .context("signed memo missing")?
                        .to_owned(),
                );
                let mut data = self.data.lock().unwrap();
                data.operations.insert(id.clone(), op.clone());
                self.persist(&data)?;
            }
            let memo = op.memo_hex.as_ref().unwrap();
            let path = self.config.state_dir.join(format!("command-{id}.hex"));
            if path.exists() {
                ensure!(
                    fs::read_to_string(&path)? == *memo,
                    "command journal mismatch"
                );
            } else {
                write_atomic(&path, memo.as_bytes())?;
            }
            let mut cmd = hidden_command(&self.config.wallet_executable);
            cmd.args(["live-command", path.to_str().context("memo path encoding")?])
                .env("ZCANARY_WALLET_STATE_DIR", &self.config.wallet_state_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = cmd.spawn().context("start wallet command")?;
            let stdout = child.stdout.take().context("wallet output missing")?;
            let mut event_path = None;
            for line in BufReader::new(stdout).lines() {
                let line = line?;
                ensure!(line.len() < 8192, "wallet output line too large");
                if let Some(txid) = line.strip_prefix("txid=") {
                    checked_hex(txid, 64)?;
                    let mut data = self.data.lock().unwrap();
                    let stored = data.operations.get_mut(&id).unwrap();
                    stored.txid = Some(txid.into());
                    stored.state = "broadcast".into();
                    self.persist(&data)?;
                }
                if let Some(path) = line.strip_prefix("command_event=") {
                    event_path = Some(PathBuf::from(path));
                }
            }
            ensure!(
                child.wait()?.success(),
                "wallet operation failed or has an uncertain broadcast outcome"
            );
            let event_path =
                event_path.context("wallet did not produce confirmed scan evidence")?;
            let event_path = event_path.canonicalize()?;
            ensure!(
                event_path.starts_with(self.config.wallet_state_dir.canonicalize()?),
                "wallet event path outside state"
            );
            let event: Value = serde_json::from_slice(&read_bounded(&event_path, 64 * 1024)?)?;
            ensure!(
                event["raw_memo_hex"] == *memo
                    && event["network"] == "testnet"
                    && event["scanner"] == "ufvk-only",
                "wallet evidence does not match the signed command"
            );
            let txid = event["txid"].as_str().context("transaction ID missing")?;
            checked_hex(txid, 64)?;
            let height = u32::try_from(
                event["block_height"]
                    .as_u64()
                    .context("confirmed height missing")?,
            )?;
            let mut data = self.data.lock().unwrap();
            let stored = data.operations.get_mut(&id).unwrap();
            stored.state = "confirmed".into();
            stored.txid = Some(txid.into());
            stored.block_height = Some(height);
            stored.error = None;
            let vault = data.vaults.get_mut(&op.vault_id).unwrap();
            if op.action != "cancel" {
                vault.last_expiry = Some(op.expiry_height);
            }
            vault.events.push(json!({"type":op.action,"message":format!("{} memo recovered from testnet",op.action),"txid":txid,"blockHeight":height}));
            self.persist(&data)?;
            Ok(())
        })();
        if result.is_err() {
            if let Ok(mut data) = self.data.lock() {
                if let Some(op) = data.operations.get_mut(&id) {
                    op.state = "failed".into();
                    op.error=Some("Wallet operation did not complete. Its durable journal is preserved; no uncertain send is automatically repeated.".into());
                }
                let _ = self.persist(&data);
            }
        }
    }
    fn watch(self: Arc<Self>, index: usize) {
        while !self.stop.load(Ordering::Acquire) {
            if self.scan_and_deliver(index).is_err() {
                let _ = keeper_request(
                    &self.keepers[index],
                    "POST",
                    "/v1/scan-failed",
                    Some(&json!({})),
                );
            }
            for _ in 0..30 {
                if self.stop.load(Ordering::Acquire) {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
    fn scan_and_deliver(&self, index: usize) -> Result<()> {
        let keeper = &self.keepers[index];
        let status = keeper_request(keeper, "GET", "/v1/status", None)?;
        let cursor = &status["cursor"];
        let start = cursor["height"].as_u64().context("keeper cursor missing")? + 1;
        let previous = cursor["hash_hex"].as_str().context("keeper hash missing")?;
        let target = {
            let data = self.data.lock().unwrap();
            data.vaults
                .values()
                .filter_map(|v| v.manifest["confirmationTarget"].as_u64())
                .max()
                .unwrap_or(2)
                .max(2)
        };
        // One bounded UFVK scanner at a time; identical cursors share a freshly verified batch.
        // Five keeper processes still independently verify and apply the complete batch.
        let cache_key = format!("{start}:{previous}:{target}");
        let batch = {
            let mut cache = self.scan_lock.lock().unwrap();
            if let Some((key, at, batch)) = cache
                .as_ref()
                .filter(|(key, at, _)| key == &cache_key && at.elapsed() < Duration::from_secs(15))
            {
                let _ = (key, at);
                batch.clone()
            } else {
                let batch = wallet_json(
                    &self.config,
                    &[
                        "scan-batch".into(),
                        self.config
                            .state_dir
                            .join("registry-viewer.dpapi")
                            .to_string_lossy()
                            .into_owned(),
                        start.to_string(),
                        previous.into(),
                        target.to_string(),
                    ],
                )?;
                *cache = Some((cache_key, std::time::Instant::now(), batch.clone()));
                batch
            }
        };
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        if batch["status"] == "no-new-blocks" {
            return Ok(());
        }
        ensure!(
            batch["adapter"] == "testnet-chain" && batch["complete"] == true,
            "scanner did not provide a complete testnet batch"
        );
        keeper_request(keeper, "POST", "/v1/confirmed-batch", Some(&batch))?;
        for _ in 0..100 {
            let response = keeper_request(keeper, "GET", "/v1/next-delivery", None)?;
            let delivery = &response["delivery"];
            if delivery.is_null() {
                break;
            }
            let id = delivery["switch_id_hex"]
                .as_str()
                .context("delivery vault missing")?;
            let vault = self
                .data
                .lock()
                .unwrap()
                .vaults
                .get(id)
                .cloned()
                .context("unknown delivery vault")?;
            ensure!(
                delivery["manifest_digest_hex"] == vault.manifest["manifestDigestHex"],
                "delivery manifest mismatch"
            );
            let key = delivery["idempotency_key"]
                .as_str()
                .context("delivery key missing")?
                .to_owned();
            if !vault.deliveries.contains_key(&keeper.id) {
                let _recipient = self.recipient_lock.lock().unwrap();
                let accepted = vault_json(
                    &self.config,
                    "recipient",
                    "accept-share",
                    &json!({"manifest":vault.manifest,"deliveryHex":delivery["payload_hex"],"keeperRecipients":vault.keeper_recipients}),
                )?;
                ensure!(
                    accepted["keeperIndex"].as_u64() == Some((index + 1) as u64),
                    "delivery keeper index mismatch"
                );
                let mut data = self.data.lock().unwrap();
                let record = data.vaults.get_mut(id).context("vault missing")?;
                record.deliveries.insert(
                    keeper.id.clone(),
                    json!({"key":key,"payloadHex":delivery["payload_hex"]}),
                );
                record.events.push(json!({"type":"share","message":format!("Validated share received from {}",keeper.id)}));
                self.persist(&data)?;
            } else {
                ensure!(
                    vault.deliveries[&keeper.id]["key"] == key
                        && vault.deliveries[&keeper.id]["payloadHex"] == delivery["payload_hex"],
                    "duplicate delivery differs"
                );
            }
            // Re-persist matching duplicates too: an earlier in-memory update may have
            // survived a failed disk write. Never acknowledge an undurable share.
            {let data=self.data.lock().unwrap();self.persist(&data)?;}
            keeper_request(
                keeper,
                "POST",
                "/v1/ack-delivery",
                Some(
                    &json!({"delivery_id":delivery["delivery_id"],"delivered":true,"cursor":delivery["cursor"]}),
                ),
            )?;
        }
        Ok(())
    }
    pub fn decrypt(&self, id: &str) -> Result<Value> {
        ensure!(!self.stop.load(Ordering::Acquire),"runtime stopped");
        checked_hex(id, 64)?;
        let vault = self
            .data
            .lock()
            .unwrap()
            .vaults
            .get(id)
            .cloned()
            .context("vault not found")?;
        ensure!(
            vault.deliveries.len() >= 3,
            "three validated keeper shares are required"
        );
        let source = self.config.state_dir.join("source").canonicalize()?;
        let package_path = vault.package_path.canonicalize()?;
        ensure!(
            package_path.starts_with(source),
            "package path outside source state"
        );
        let package = read_bounded(&package_path, 10 * 1024 * 1024 + 65536)?;
        let shares: Vec<Value> = vault
            .deliveries
            .values()
            .map(|v| v["payloadHex"].clone())
            .collect();
        let _recipient = self.recipient_lock.lock().unwrap();
        let mut output = vault_json(
            &self.config,
            "recipient",
            "decrypt",
            &json!({"manifest":vault.manifest,"packageBase64":STANDARD.encode(package),"deliveriesHex":shares,"keeperRecipients":vault.keeper_recipients}),
        )?;
        output["fileName"] = json!(vault.file_name);
        Ok(output)
    }
}

fn package_export(manifest: &Value, bytes: &[u8]) -> Result<Value> {
    use zcanary_crypto::{EncryptedPackage, PackageContext, public_package_digest};
    ensure!(manifest["network"] == 1 && manifest["packageSize"].as_u64() == Some(bytes.len() as u64), "package size or network mismatch");
    let recipient = bytes32(manifest["recipientPubKeyHex"].as_str().context("recipient public key missing")?)?;
    let context = PackageContext {
        switch_id: bytes32(manifest["switchIdHex"].as_str().context("vault identifier missing")?)?,
        epoch: u32::try_from(manifest["configurationEpoch"].as_u64().context("configuration epoch missing")?)?,
        recipient_fingerprint: Sha256::digest(recipient).into(),
    };
    let package = EncryptedPackage::from_bytes(bytes)?;
    let digest = hex::encode(public_package_digest(&package, context));
    ensure!(manifest["packageDigestHex"] == digest, "encrypted package differs from signed manifest digest");
    Ok(json!({"format":"ZCANARY-ENCRYPTED-PACKAGE-V1","manifest":manifest,"packageBase64":STANDARD.encode(bytes),"packageDigestHex":digest}))
}

fn operation_public(op: &Operation) -> Value {
    json!({"operationId":op.operation_id,"state":op.state,"txid":op.txid,"blockHeight":op.block_height,"error":op.error})
}
fn random_id() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("secure random unavailable"))?;
    Ok(hex::encode(bytes))
}
fn checked_hex(value: &str, length: usize) -> Result<()> {
    ensure!(
        value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid identifier"
    );
    Ok(())
}
fn bytes32(value: &str) -> Result<[u8; 32]> {
    checked_hex(value, 64)?;
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid 32-byte field"))
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "file exceeds size limit");
    Ok(bytes)
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", random_id()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    Ok(())
}
fn hidden_command(path: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn run_json(mut command: Command, input: Option<&Value>) -> Result<Value> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    if let Some(input) = input {
        let bytes = Zeroizing::new(serde_json::to_vec(input)?);
        child
            .stdin
            .take()
            .context("subprocess stdin missing")?
            .write_all(&bytes)?;
    } else {
        drop(child.stdin.take());
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "native subprocess did not complete successfully"
    );
    ensure!(
        output.stdout.len() <= 16 * 1024 * 1024,
        "native response too large"
    );
    let clear = Zeroizing::new(output.stdout);
    Ok(serde_json::from_slice(&clear).context("native response is not JSON")?)
}
fn wallet_json(config: &RuntimeConfig, args: &[String]) -> Result<Value> {
    let mut command = hidden_command(&config.wallet_executable);
    command
        .args(args)
        .env("ZCANARY_WALLET_STATE_DIR", &config.wallet_state_dir);
    run_json(command, None)
}
fn vault_json(config: &RuntimeConfig, role: &str, action: &str, input: &Value) -> Result<Value> {
    let mut command = hidden_command(&config.vault_executable);
    command
        .arg("--state-dir")
        .arg(config.state_dir.join(role))
        .arg(action);
    run_json(command, Some(input))
}
fn dpapi(config: &RuntimeConfig, operation: &str, input: &[u8]) -> Result<Vec<u8>> {
    let encoded = Zeroizing::new(if operation == "Protect" {
        STANDARD.encode(input)
    } else {
        std::str::from_utf8(input)?.to_owned()
    });
    let mut cmd = hidden_command("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(&config.dpapi_script)
        .arg(operation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    child
        .stdin
        .take()
        .context("DPAPI stdin missing")?
        .write_all(encoded.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(output.status.success(), "local encrypted storage failed");
    if operation == "Protect" {
        Ok(output.stdout)
    } else {
        Ok(STANDARD.decode(std::str::from_utf8(&output.stdout)?.trim())?)
    }
}
fn protect(config: &RuntimeConfig, bytes: &[u8]) -> Result<Vec<u8>> {
    dpapi(config, "Protect", bytes)
}
fn unprotect(config: &RuntimeConfig, bytes: &[u8]) -> Result<Vec<u8>> {
    dpapi(config, "Unprotect", bytes)
}
fn keeper_request(
    connection: &Connection,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let bytes = body
        .map(serde_json::to_vec)
        .transpose()?
        .unwrap_or_default();
    let mut stream = TcpStream::connect_timeout(&connection.address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    stream.set_write_timeout(Some(Duration::from_secs(8)))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        connection.address,
        connection.token,
        bytes.len()
    )?;
    stream.write_all(&bytes)?;
    let mut result = Vec::new();
    stream.take(512 * 1024).read_to_end(&mut result)?;
    let split = result
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .context("invalid keeper response")?;
    let headers = std::str::from_utf8(&result[..split])?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .context("keeper status missing")?;
    ensure!(
        status == "200" || status == "201",
        "keeper rejected the request"
    );
    Ok(serde_json::from_slice(&result[split + 4..])?)
}
fn verify_ack(keeper: &Connection, provision: &Value, ack: &Value) -> Result<()> {
    ensure!(
        ack["keeper_id"] == keeper.id
            && ack["keeper_index"] == provision["keeper_index"]
            && ack["signing_pubkey_hex"] == keeper.public["signing_pubkey_hex"]
            && ack["switch_id_hex"] == provision["manifest"]["switchIdHex"]
            && ack["manifest_digest_hex"] == provision["manifest"]["manifestDigestHex"]
            && ack["epoch"] == provision["manifest"]["configurationEpoch"],
        "keeper acknowledgement context mismatch"
    );
    let envelope = &provision["envelope"];
    let wire = format!(
        "{{\"version\":{},\"keeper_id_hex\":\"{}\",\"index\":{},\"ciphertext_hex\":\"{}\"}}",
        envelope["version"],
        envelope["keeper_id_hex"]
            .as_str()
            .context("envelope key missing")?,
        envelope["index"],
        envelope["ciphertext_hex"]
            .as_str()
            .context("envelope ciphertext missing")?
    );
    let digest = hex::encode(Sha256::digest(wire.as_bytes()));
    ensure!(
        ack["envelope_digest_hex"] == digest,
        "acknowledgement envelope mismatch"
    );
    let mut message = b"z-canary/keeper-provision-ack/v1\0".to_vec();
    message.extend_from_slice(keeper.id.as_bytes());
    message.push(u8::try_from(
        ack["keeper_index"]
            .as_u64()
            .context("keeper index missing")?,
    )?);
    message.extend_from_slice(&bytes32(ack["switch_id_hex"].as_str().unwrap())?);
    message.extend_from_slice(
        &u32::try_from(ack["epoch"].as_u64().context("epoch missing")?)?.to_le_bytes(),
    );
    message.extend_from_slice(&bytes32(ack["manifest_digest_hex"].as_str().unwrap())?);
    message.extend_from_slice(&bytes32(&digest)?);
    let key = VerifyingKey::from_bytes(&bytes32(
        keeper.public["signing_pubkey_hex"]
            .as_str()
            .context("keeper key missing")?,
    )?)?;
    let signature = Signature::from_slice(&hex::decode(
        ack["signature_hex"]
            .as_str()
            .context("keeper signature missing")?,
    )?)?;
    key.verify_strict(&message, &signature)?;
    Ok(())
}

#[cfg(test)]
mod acknowledgement_tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn ciphertext_export_checks_manifest_binding_and_omits_private_metadata() {
        use zcanary_crypto::{EncryptedPackage, PackageContext, public_package_digest};
        let package = EncryptedPackage { version: 1, nonce: [3;24], ciphertext: vec![4;48] };
        let bytes = package.to_bytes().unwrap();
        let context = PackageContext { switch_id: [1;32], epoch: 2, recipient_fingerprint: Sha256::digest([2;32]).into() };
        let manifest = json!({"network":1,"switchIdHex":hex::encode([1;32]),"configurationEpoch":2,"recipientPubKeyHex":hex::encode([2;32]),"packageSize":bytes.len(),"packageDigestHex":hex::encode(public_package_digest(&package,context))});
        let exported = package_export(&manifest, &bytes).unwrap();
        assert_eq!(exported["format"], "ZCANARY-ENCRYPTED-PACKAGE-V1");
        assert_eq!(exported["packageBase64"], STANDARD.encode(&bytes));
        assert_eq!(exported.as_object().unwrap().len(), 4);
        assert!(exported.get("fileName").is_none());
        let mut altered = bytes;
        *altered.last_mut().unwrap() ^= 1;
        assert!(package_export(&manifest, &altered).is_err());
        let mut context_mismatch = manifest;
        context_mismatch["configurationEpoch"] = json!(3);
        assert!(package_export(&context_mismatch, &package.to_bytes().unwrap()).is_err());
    }

    fn signed_acknowledgement() -> (Connection, Value, Value) {
        let signing = SigningKey::from_bytes(&[17; 32]);
        let public_key = hex::encode(signing.verifying_key().to_bytes());
        let keeper = Connection {
            id: "keeper-03".into(),
            address: "127.0.0.1:1".parse().unwrap(),
            token: "unused-test-token".into(),
            public: json!({"signing_pubkey_hex":public_key}),
        };
        let envelope_wire = format!(
            "{{\"version\":1,\"keeper_id_hex\":\"{}\",\"index\":3,\"ciphertext_hex\":\"01234567\"}}",
            "ab".repeat(32)
        );
        let envelope_digest = Sha256::digest(envelope_wire.as_bytes());
        let provision = json!({
            "keeper_index":3,
            "manifest":{"switchIdHex":hex::encode([4;32]), "manifestDigestHex":hex::encode([5;32]), "configurationEpoch":7},
            "envelope":serde_json::from_str::<Value>(&envelope_wire).unwrap()
        });
        // Assemble the published acknowledgement transcript independently from the verifier.
        let transcript = [
            &b"z-canary/keeper-provision-ack/v1\0"[..], &b"keeper-03"[..], &[3][..],
            &[4;32][..], &7u32.to_le_bytes()[..], &[5;32][..], &envelope_digest[..],
        ].concat();
        let ack = json!({
            "keeper_id":"keeper-03", "keeper_index":3, "switch_id_hex":hex::encode([4;32]),
            "manifest_digest_hex":hex::encode([5;32]), "epoch":7,
            "envelope_digest_hex":hex::encode(envelope_digest), "signing_pubkey_hex":public_key,
            "signature_hex":hex::encode(signing.sign(&transcript).to_bytes())
        });
        (keeper, provision, ack)
    }

    #[test]
    fn acknowledgement_requires_signature_and_exact_provisioned_context() {
        let (keeper, provision, ack) = signed_acknowledgement();
        verify_ack(&keeper, &provision, &ack).unwrap();
        for (field, replacement) in [
            ("keeper_id", json!("keeper-04")), ("keeper_index", json!(4)),
            ("switch_id_hex", json!(hex::encode([6;32]))),
            ("manifest_digest_hex", json!(hex::encode([6;32]))),
            ("epoch", json!(8)), ("envelope_digest_hex", json!(hex::encode([6;32]))),
            ("signing_pubkey_hex", json!(hex::encode([6;32]))),
            ("signature_hex", json!(hex::encode([0;64]))),
        ] {
            let mut altered = ack.clone();
            altered[field] = replacement;
            assert!(verify_ack(&keeper, &provision, &altered).is_err(), "accepted altered {field}");
        }
        let mut altered_provision = provision;
        altered_provision["envelope"]["ciphertext_hex"] = json!("01234568");
        assert!(verify_ack(&keeper, &altered_provision, &ack).is_err());
    }
}
