use std::{collections::HashSet, io::Read, net::SocketAddr, path::Path, str::FromStr, sync::Arc};

use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zcanary_core::{Command, Operation, decode_and_verify_memo};
pub mod runtime;
use runtime::Runtime;

const DEFAULT_LISTEN: &str = "127.0.0.1:8787";
const MAX_REQUEST_BODY: usize = 16 * 1024;
const MAX_NATIVE_CREATE_BODY: usize = 16 * 1024 * 1024;
const MAX_IDENTITY_BACKUP_BODY: usize = 512 * 1024;
const MAX_EVIDENCE_FILE_BYTES: usize = 256 * 1024;
const MAX_EVIDENCE_RUNS: usize = 16;
const MAX_EVIDENCE_CHECKS: usize = 128;
const MAX_EVIDENCE_TRANSACTIONS: usize = 128;
const MAX_EVIDENCE_LIMITATIONS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceReport {
    pub version: u8,
    pub label: String,
    pub runs: Vec<EvidenceRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRun {
    pub label: String,
    pub mode: EvidenceMode,
    pub checks: Vec<EvidenceCheck>,
    pub transactions: Vec<EvidenceTransaction>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceMode {
    Testnet,
    SyntheticChain,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceCheck {
    pub name: String,
    pub passed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceTransaction {
    pub label: String,
    pub txid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<u32>,
    pub network: EvidenceNetwork,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceNetwork {
    Testnet,
}

#[derive(Clone)]
pub struct AgentState {
    token: Arc<[u8]>,
    allowed_origins: Arc<HashSet<String>>,
    evidence: Option<Arc<EvidenceReport>>,
    runtime: Option<Arc<Runtime>>,
}

impl AgentState {
    pub fn new(
        token: Vec<u8>,
        allowed_origins: impl IntoIterator<Item = String>,
    ) -> Result<Self, String> {
        validate_token(&token)?;
        let mut origins = HashSet::new();
        for origin in allowed_origins {
            if !is_loopback_http_origin(&origin) {
                return Err("allowed origins must be exact loopback HTTP origins".into());
            }
            origins.insert(origin);
        }
        Ok(Self {
            token: token.into(),
            allowed_origins: Arc::new(origins),
            evidence: None,
            runtime: None,
        })
    }

    pub fn with_evidence(mut self, evidence: EvidenceReport) -> Result<Self, String> {
        validate_evidence_report(&evidence)?;
        self.evidence = Some(Arc::new(evidence));
        Ok(self)
    }

    pub fn with_runtime(mut self, runtime: Arc<Runtime>) -> Self {
        self.runtime = Some(runtime);
        self
    }
}

pub fn read_evidence_file(path: &Path) -> Result<EvidenceReport, String> {
    let file = std::fs::File::open(path).map_err(|_| "could not read evidence file".to_owned())?;
    let mut bytes = Vec::new();
    file.take((MAX_EVIDENCE_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read evidence file".to_owned())?;
    if bytes.len() > MAX_EVIDENCE_FILE_BYTES {
        return Err("evidence file exceeds the size limit".into());
    }
    let report: EvidenceReport = serde_json::from_slice(&bytes)
        .map_err(|_| "evidence file does not match schema version 1".to_owned())?;
    validate_evidence_report(&report)?;
    Ok(report)
}

fn validate_evidence_report(report: &EvidenceReport) -> Result<(), String> {
    if report.version != 1
        || !valid_evidence_text(&report.label, 80)
        || report.runs.is_empty()
        || report.runs.len() > MAX_EVIDENCE_RUNS
    {
        return Err("evidence report failed schema validation".into());
    }
    for run in &report.runs {
        if !valid_evidence_text(&run.label, 80)
            || run.checks.len() > MAX_EVIDENCE_CHECKS
            || run.transactions.len() > MAX_EVIDENCE_TRANSACTIONS
            || run.limitations.len() > MAX_EVIDENCE_LIMITATIONS
            || run
                .checks
                .iter()
                .any(|check| !valid_evidence_text(&check.name, 120))
            || run
                .limitations
                .iter()
                .any(|limitation| !valid_evidence_text(limitation, 400))
            || run.transactions.iter().any(|tx| {
                !valid_evidence_text(&tx.label, 120)
                    || tx.txid.len() != 64
                    || !tx.txid.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            || (run.mode == EvidenceMode::SyntheticChain && !run.transactions.is_empty())
        {
            return Err("evidence report failed schema validation".into());
        }
    }
    Ok(())
}

fn valid_evidence_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

#[derive(Clone)]
struct RequestContext {
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    error: ErrorDetails,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetails {
    code: &'static str,
    message: &'static str,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyRequest {
    #[serde(rename = "memoHex")]
    memo_hex: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    service: &'static str,
    state: &'static str,
    network: &'static str,
    simulation: bool,
    wallet: WalletStatus,
    keepers: KeeperStatus,
    capabilities: Capabilities,
}

#[derive(Serialize)]
struct WalletStatus {
    available: bool,
    state: &'static str,
}
#[derive(Serialize)]
struct KeeperStatus {
    running: bool,
    state: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    memo_verification: bool,
    wallet_commands: bool,
    keeper_release: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedMemo {
    verified: bool,
    network: u8,
    operation: &'static str,
    switch_id_hex: String,
    sequence: String,
    requested_expiry_height: u32,
    manifest_digest_hex: String,
    source_pubkey_hex: String,
}

pub fn parse_listen_addr(value: &str) -> Result<SocketAddr, String> {
    let address = SocketAddr::from_str(value)
        .map_err(|_| "listen address must be an IP socket address".to_owned())?;
    if !address.ip().is_loopback() {
        return Err("listen address must use a loopback IP".into());
    }
    Ok(address)
}

pub fn is_loopback_http_origin(value: &str) -> bool {
    let Some(authority) = value.strip_prefix("http://") else {
        return false;
    };
    if authority.is_empty()
        || authority
            .chars()
            .any(|c| matches!(c, '/' | '?' | '#' | '@'))
    {
        return false;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let Some((host, suffix)) = rest.split_once(']') else {
            return false;
        };
        if host != "::1" {
            return false;
        }
        let port = if suffix.is_empty() {
            None
        } else {
            suffix.strip_prefix(':')
        };
        if !suffix.is_empty() && port.is_none() {
            return false;
        }
        ("[::1]", port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') {
            return false;
        }
        (host, Some(port))
    } else {
        (authority, None)
    };
    if !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        return false;
    }
    match port {
        None => true,
        Some(p) => {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n != 0)
        }
    }
}

pub fn validate_token(token: &[u8]) -> Result<(), String> {
    // 43 base64url characters encode 256 random bits without padding.
    if token.len() < 43
        || token.len() > 4096
        || !token
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
    {
        return Err("token file must contain a base64url token of at least 43 characters".into());
    }
    Ok(())
}

pub fn read_token_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|_| "could not read token file".to_owned())?;
    let mut raw = Vec::new();
    file.take(4099)
        .read_to_end(&mut raw)
        .map_err(|_| "could not read token file".to_owned())?;
    if raw.len() > 4098 {
        return Err("token file is too large".into());
    }
    let token = raw
        .strip_suffix(b"\r\n")
        .or_else(|| raw.strip_suffix(b"\n"))
        .unwrap_or(&raw)
        .to_vec();
    validate_token(&token)?;
    Ok(token)
}

pub fn app(state: AgentState) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/evidence", get(evidence))
        .route("/v1/memos/verify", post(verify_memo))
        .route("/v1/runtime", get(native_request))
        .route("/v1/fees", get(native_request))
        .route("/v1/runtime/stop", post(native_request))
        .route("/v1/recipient/identity", post(native_request))
        .route("/v1/recipient/inbox", get(native_request))
        .route("/v1/recipient/vaults/{id}/decrypt", post(native_request))
        .route("/v1/vaults", get(native_request).post(native_request))
        .route("/v1/vaults/{id}", get(native_request))
        .route("/v1/vaults/{id}/events", get(native_request))
        .route("/v1/vaults/{id}/package", get(native_request))
        .route("/v1/vaults/{id}/register", post(native_request))
        .route("/v1/vaults/{id}/postpone", post(native_request))
        .route("/v1/vaults/{id}/cancel", post(native_request))
        .route("/v1/vaults/{id}/provision", post(native_request))
        .route("/v1/operations/{id}", get(native_request))
        .route("/v1/operations/{id}/retry", post(native_request))
        .route("/v1/identity/{role}/export", post(native_request))
        .route("/v1/identity/{role}/import", post(native_request))
        .route(
            "/v1/support-request",
            get(native_request).post(native_request),
        )
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), request_guard))
        .with_state(state)
}

async fn request_guard(
    State(state): State<AgentState>,
    mut request: Request,
    next: Next,
) -> Response {
    let request_id = match new_id() {
        Ok(id) => id,
        Err(_) => {
            let context = RequestContext {
                request_id: "unavailable".to_owned(),
            };
            return response_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ERR_ENTROPY_UNAVAILABLE",
                "request identifier could not be generated",
                &context,
                None,
                None,
            );
        }
    };
    let context = RequestContext {
        request_id: request_id.clone(),
    };

    let mut origins = request.headers().get_all(header::ORIGIN).iter();
    let origin = match origins.next() {
        Some(value) if origins.next().is_none() => match value.to_str() {
            Ok(value) if state.allowed_origins.contains(value) => Some(value.to_owned()),
            _ => {
                return response_error(
                    StatusCode::FORBIDDEN,
                    "ERR_ORIGIN_NOT_ALLOWED",
                    "request origin is not allowed",
                    &context,
                    None,
                    None,
                );
            }
        },
        Some(_) => {
            return response_error(
                StatusCode::FORBIDDEN,
                "ERR_ORIGIN_NOT_ALLOWED",
                "request origin is not allowed",
                &context,
                None,
                None,
            );
        }
        None => None,
    };

    if request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD)
    {
        let Some(allowed_origin) = origin.as_deref() else {
            return response_error(
                StatusCode::FORBIDDEN,
                "ERR_ORIGIN_NOT_ALLOWED",
                "preflight origin is not allowed",
                &context,
                None,
                None,
            );
        };
        if !preflight_allowed(request.headers()) {
            return response_error(
                StatusCode::FORBIDDEN,
                "ERR_PREFLIGHT_NOT_ALLOWED",
                "preflight method or headers are not allowed",
                &context,
                None,
                Some(allowed_origin),
            );
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors(response.headers_mut(), allowed_origin);
        return attach_request_id(response, &request_id);
    }

    let is_v1 = request.uri().path() == "/v1" || request.uri().path().starts_with("/v1/");
    if is_v1 && !authorized(request.headers(), &state.token) {
        return response_error(
            StatusCode::UNAUTHORIZED,
            "ERR_UNAUTHORIZED",
            "bearer authentication required",
            &context,
            None,
            origin.as_deref(),
        );
    }

    if method_not_allowed(request.method(), request.uri().path()) {
        return response_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "ERR_METHOD_NOT_ALLOWED",
            "method is not allowed for this route",
            &context,
            None,
            origin.as_deref(),
        );
    }

    let body_limit = request_body_limit(
        state.runtime.is_some(),
        request.method(),
        request.uri().path(),
    );
    if let Some(length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
    {
        if length > body_limit {
            return response_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ERR_BODY_TOO_LARGE",
                "request body exceeds the size limit",
                &context,
                None,
                origin.as_deref(),
            );
        }
    }
    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, body_limit).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return response_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ERR_BODY_TOO_LARGE",
                "request body exceeds the size limit",
                &context,
                None,
                origin.as_deref(),
            );
        }
    };
    request = Request::from_parts(parts, Body::from(bytes));
    request.extensions_mut().insert(context.clone());
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(origin) = origin.as_deref() {
        apply_cors(response.headers_mut(), origin);
    }
    attach_request_id(response, &request_id)
}

fn authorized(headers: &axum::http::HeaderMap, token: &[u8]) -> bool {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    let Ok(value) = value.to_str() else {
        return false;
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return false;
    };
    let candidate = candidate.as_bytes();
    if token.len() != candidate.len() {
        return false;
    }
    bool::from(token.ct_eq(candidate))
}

fn preflight_allowed(headers: &axum::http::HeaderMap) -> bool {
    let method = headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|v| v.to_str().ok());
    if !matches!(method, Some("GET" | "POST")) {
        return false;
    }
    let Some(raw_headers) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) else {
        return true;
    };
    let Ok(raw_headers) = raw_headers.to_str() else {
        return false;
    };
    raw_headers.split(',').all(|h| {
        matches!(
            h.trim().to_ascii_lowercase().as_str(),
            "authorization" | "content-type"
        )
    })
}

fn method_not_allowed(method: &Method, path: &str) -> bool {
    let allowed: Option<&[Method]> = match path {
        "/v1/status" | "/v1/evidence" | "/v1/runtime" | "/v1/fees" | "/v1/recipient/inbox" => {
            Some(&[Method::GET])
        }
        "/v1/memos/verify" | "/v1/runtime/stop" | "/v1/recipient/identity" => Some(&[Method::POST]),
        "/v1/vaults" | "/v1/support-request" => Some(&[Method::GET, Method::POST]),
        _ => match path.split('/').collect::<Vec<_>>().as_slice() {
            ["", "v1", "vaults" | "operations", id] if !id.is_empty() => Some(&[Method::GET]),
            [
                "",
                "v1",
                "vaults",
                id,
                "register" | "postpone" | "cancel" | "provision",
            ] if !id.is_empty() => Some(&[Method::POST]),
            ["", "v1", "operations", id, "retry"] if !id.is_empty() => Some(&[Method::POST]),
            ["", "v1", "vaults", id, "events" | "package"] if !id.is_empty() => {
                Some(&[Method::GET])
            }
            ["", "v1", "recipient", "vaults", id, "decrypt"] if !id.is_empty() => {
                Some(&[Method::POST])
            }
            ["", "v1", "identity", role, "export" | "import"] if !role.is_empty() => {
                Some(&[Method::POST])
            }
            _ => None,
        },
    };
    allowed.is_some_and(|allowed| !allowed.contains(method))
}

fn request_body_limit(runtime_configured: bool, method: &Method, path: &str) -> usize {
    if runtime_configured && method == Method::POST && path == "/v1/vaults" {
        MAX_NATIVE_CREATE_BODY
    } else if runtime_configured
        && method == Method::POST
        && matches!(
            path.split('/').collect::<Vec<_>>().as_slice(),
            [
                "",
                "v1",
                "identity",
                "source" | "recipient",
                "export" | "import"
            ]
        )
    {
        MAX_IDENTITY_BACKUP_BODY
    } else {
        MAX_REQUEST_BODY
    }
}

fn apply_cors(headers: &mut axum::http::HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

async fn status(State(state): State<AgentState>) -> Json<StatusResponse> {
    let live = if let Some(runtime) = state.runtime {
        tokio::task::spawn_blocking(move || runtime.status())
            .await
            .ok()
    } else {
        None
    };
    let available = live
        .as_ref()
        .is_some_and(|value| value["available"] == true);
    let keepers_healthy = live
        .as_ref()
        .and_then(|value| value["keepers"].as_array())
        .is_some_and(|keepers| {
            keepers.len() == 5 && keepers.iter().all(|keeper| keeper["healthy"] == true)
        });
    Json(StatusResponse {
        service: "Z-Canary local agent",
        state: if available {
            "native-testnet"
        } else {
            "wallet-unavailable"
        },
        network: "testnet",
        simulation: false,
        wallet: WalletStatus {
            available,
            state: if available { "ready" } else { "unavailable" },
        },
        keepers: KeeperStatus {
            running: available,
            state: if keepers_healthy {
                "healthy"
            } else if available {
                "synchronizing"
            } else {
                "not-started"
            },
        },
        capabilities: Capabilities {
            memo_verification: true,
            wallet_commands: available,
            keeper_release: keepers_healthy,
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceResponse {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<EvidenceReport>,
}

async fn evidence(State(state): State<AgentState>) -> Json<EvidenceResponse> {
    let report = state.evidence.as_deref().cloned();
    Json(EvidenceResponse {
        available: report.is_some(),
        report,
    })
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeCreateRequest {
    file_name: String,
    contents_base64: String,
    recipient: String,
    recipient_fingerprint: String,
    interval_blocks: u32,
    grace_blocks: u32,
    confirmation_target: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityBackup {
    version: u8,
    role: String,
    fingerprint: String,
    encrypted_base64: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IdentityExportRequest {
    passphrase: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityImportRequest {
    passphrase: String,
    expected_fingerprint: String,
    backup: IdentityBackup,
}

async fn native_request(
    State(state): State<AgentState>,
    Extension(context): Extension<RequestContext>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let Some(runtime) = state.runtime else {
        if path == "/v1/runtime" {
            return Json(serde_json::json!({
                "available": false, "mode": "testnet",
                "wallet": {"available": false, "state": "unavailable"},
                "keepers": [], "error": "Native runtime is not configured."
            }))
            .into_response();
        }
        return wallet_unavailable(Extension(context)).await;
    };
    let segments = path.split('/').collect::<Vec<_>>();
    if matches!(segments.as_slice(), ["", "v1", "identity", role, _] if !matches!(*role, "source" | "recipient"))
    {
        return response_error(
            StatusCode::BAD_REQUEST,
            "ERR_IDENTITY_ROLE",
            "identity role must be source or recipient",
            &context,
            None,
            None,
        );
    }
    let identifier = match segments.as_slice() {
        ["", "v1", "vaults", id]
        | ["", "v1", "vaults", id, _]
        | ["", "v1", "recipient", "vaults", id, "decrypt"] => Some((*id, 64)),
        ["", "v1", "operations", id] | ["", "v1", "operations", id, "retry"] => Some((*id, 32)),
        _ => None,
    };
    if identifier.is_some_and(|(id, length)| {
        id.len() != length || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return response_error(
            StatusCode::BAD_REQUEST,
            "ERR_IDENTIFIER",
            "identifier is invalid",
            &context,
            None,
            None,
        );
    }
    let mut input = serde_json::json!({});
    if method == Method::POST {
        let json_type = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("application/json")
            });
        if !json_type {
            return response_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "ERR_CONTENT_TYPE",
                "application/json is required",
                &context,
                None,
                None,
            );
        }
        let limit = request_body_limit(true, &method, &path);
        let bytes = match to_bytes(request.into_body(), limit).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return response_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "ERR_BODY_TOO_LARGE",
                    "request body exceeds the size limit",
                    &context,
                    None,
                    None,
                );
            }
        };
        let parsed = if path == "/v1/vaults" {
            serde_json::from_slice::<NativeCreateRequest>(&bytes)
                .ok()
                .and_then(|value| {
                    if value.file_name.is_empty()
                        || value.file_name.len() > 255
                        || value.file_name.chars().any(char::is_control)
                        || value.recipient.len() > 256
                        || value.recipient_fingerprint.len() > 128
                    {
                        return None;
                    }
                    serde_json::to_value(value).ok()
                })
        } else if matches!(segments.as_slice(), ["", "v1", "identity", _, "export"]) {
            serde_json::from_slice::<IdentityExportRequest>(&bytes)
                .ok()
                .and_then(|value| serde_json::to_value(value).ok())
        } else if matches!(segments.as_slice(), ["", "v1", "identity", _, "import"]) {
            serde_json::from_slice::<IdentityImportRequest>(&bytes)
                .ok()
                .and_then(|value| serde_json::to_value(value).ok())
        } else {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .filter(|value| value.as_object().is_some_and(|object| object.is_empty()))
        };
        input = match parsed {
            Some(input) => input,
            None => {
                return response_error(
                    StatusCode::BAD_REQUEST,
                    "ERR_REQUEST_BODY",
                    "request body is invalid",
                    &context,
                    None,
                    None,
                );
            }
        };
    }
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let segments = path.split('/').collect::<Vec<_>>();
        match (method, segments.as_slice()) {
            (Method::GET, ["", "v1", "runtime"]) => Ok(runtime.status()),
            (Method::GET, ["", "v1", "fees"]) => runtime.fee_estimate(),
            (Method::POST, ["", "v1", "runtime", "stop"]) => {
                runtime.stop();
                Ok(serde_json::json!({"stopped": true}))
            }
            (Method::POST, ["", "v1", "recipient", "identity"]) => runtime.recipient(),
            (Method::GET, ["", "v1", "vaults"] | ["", "v1", "recipient", "inbox"]) => {
                runtime.list()
            }
            (Method::POST, ["", "v1", "vaults"]) => runtime.create(input),
            (Method::GET, ["", "v1", "vaults", id]) => runtime.detail(id),
            (Method::GET, ["", "v1", "vaults", id, "events"]) => runtime.events(id),
            (Method::GET, ["", "v1", "vaults", id, "package"]) => runtime.package(id),
            (Method::POST, ["", "v1", "vaults", id, "provision"]) => {
                runtime.provision(id)?;
                runtime.detail(id)
            }
            (
                Method::POST,
                [
                    "",
                    "v1",
                    "vaults",
                    id,
                    action @ ("register" | "postpone" | "cancel"),
                ],
            ) => runtime.submit(id, action),
            (Method::GET, ["", "v1", "operations", id]) => runtime.operation(id),
            (Method::POST, ["", "v1", "operations", id, "retry"]) => runtime.retry(id),
            (Method::POST, ["", "v1", "identity", role, action @ ("export" | "import")]) => {
                runtime.identity_backup(role, action, input)
            }
            (Method::POST, ["", "v1", "recipient", "vaults", id, "decrypt"]) => runtime.decrypt(id),
            (Method::GET | Method::POST, ["", "v1", "support-request"]) => runtime.support(),
            _ => anyhow::bail!("unsupported native route"),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(_)) => response_error(
            StatusCode::CONFLICT,
            "ERR_NATIVE_OPERATION",
            "Native operation could not complete. Check the vault state and keeper availability; no successful action is implied.",
            &context,
            None,
            None,
        ),
        Err(_) => response_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ERR_NATIVE_TASK",
            "Native task failed; its durable state is preserved.",
            &context,
            None,
            None,
        ),
    }
}

async fn verify_memo(Extension(context): Extension<RequestContext>, request: Request) -> Response {
    let Some(content_type) = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return response_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "ERR_CONTENT_TYPE",
            "application/json is required",
            &context,
            None,
            None,
        );
    };
    if !content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return response_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "ERR_CONTENT_TYPE",
            "application/json is required",
            &context,
            None,
            None,
        );
    }
    let body = match to_bytes(request.into_body(), MAX_REQUEST_BODY).await {
        Ok(body) => body,
        Err(_) => {
            return response_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ERR_BODY_TOO_LARGE",
                "request body exceeds the size limit",
                &context,
                None,
                None,
            );
        }
    };
    let input: VerifyRequest = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => {
            return response_error(
                StatusCode::BAD_REQUEST,
                "ERR_REQUEST_BODY",
                "request body is invalid",
                &context,
                None,
                None,
            );
        }
    };
    if input.memo_hex.len() != 1024 || !input.memo_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return response_error(
            StatusCode::BAD_REQUEST,
            "ERR_MEMO_INVALID",
            "memo must be exactly 512 bytes of hexadecimal",
            &context,
            None,
            None,
        );
    }
    let bytes = match hex::decode(&input.memo_hex) {
        Ok(bytes) => bytes,
        Err(_) => {
            return response_error(
                StatusCode::BAD_REQUEST,
                "ERR_MEMO_INVALID",
                "memo encoding is invalid",
                &context,
                None,
                None,
            );
        }
    };
    let command = match decode_and_verify_memo(&bytes, 1) {
        Ok(command) => command,
        Err(_) => {
            return response_error(
                StatusCode::BAD_REQUEST,
                "ERR_MEMO_INVALID",
                "memo failed protocol verification",
                &context,
                None,
                None,
            );
        }
    };
    Json(command_response(command)).into_response()
}

fn command_response(command: Command) -> VerifiedMemo {
    let operation = match command.operation {
        Operation::Register => "register",
        Operation::Postpone => "postpone",
        Operation::Cancel => "cancel",
    };
    VerifiedMemo {
        verified: true,
        network: command.network,
        operation,
        switch_id_hex: hex::encode(command.switch_id),
        sequence: command.sequence.to_string(),
        requested_expiry_height: command.requested_expiry_height,
        manifest_digest_hex: hex::encode(command.manifest_digest),
        source_pubkey_hex: hex::encode(command.source_pubkey),
    }
}

async fn wallet_unavailable(Extension(context): Extension<RequestContext>) -> Response {
    let operation_id = match new_id() {
        Ok(id) => id,
        Err(_) => {
            return response_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ERR_ENTROPY_UNAVAILABLE",
                "operation identifier could not be generated",
                &context,
                None,
                None,
            );
        }
    };
    response_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "ERR_WALLET_UNAVAILABLE",
        "wallet integration is unavailable",
        &context,
        Some(operation_id),
        None,
    )
}

async fn not_found(Extension(context): Extension<RequestContext>) -> Response {
    response_error(
        StatusCode::NOT_FOUND,
        "ERR_NOT_FOUND",
        "route not found",
        &context,
        None,
        None,
    )
}

fn response_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    context: &RequestContext,
    operation_id: Option<String>,
    origin: Option<&str>,
) -> Response {
    let mut response = (
        status,
        Json(ErrorEnvelope {
            error: ErrorDetails {
                code,
                message,
                request_id: context.request_id.clone(),
                operation_id,
            },
        }),
    )
        .into_response();
    if let Some(origin) = origin {
        apply_cors(response.headers_mut(), origin);
    }
    attach_request_id(response, &context.request_id)
}

fn attach_request_id(mut response: Response, request_id: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

fn new_id() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(hex::encode(bytes))
}

pub fn parse_cli_args(
    args: impl IntoIterator<Item = String>,
) -> Result<
    (
        SocketAddr,
        std::path::PathBuf,
        Vec<String>,
        Option<std::path::PathBuf>,
        Option<std::path::PathBuf>,
    ),
    String,
> {
    let mut args = args.into_iter();
    let mut listen = DEFAULT_LISTEN.to_owned();
    let mut token_file = None;
    let mut origins = Vec::new();
    let mut evidence_file = None;
    let mut runtime_config = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => listen = args.next().ok_or("--listen requires a socket address")?,
            "--token-file" => token_file = Some(args.next().ok_or("--token-file requires a path")?),
            "--allowed-origin" => {
                let origin = args.next().ok_or("--allowed-origin requires an origin")?;
                if !is_loopback_http_origin(&origin) { return Err("allowed origins must be exact loopback HTTP origins".into()); }
                origins.push(origin);
            }
            "--evidence-file" => evidence_file = Some(args.next().ok_or("--evidence-file requires a path")?.into()),
            "--runtime-config" => runtime_config = Some(args.next().ok_or("--runtime-config requires a path")?.into()),
            "--help" | "-h" => return Err("usage: zcanary-agent --token-file PATH [--listen LOOPBACK_IP:PORT] [--allowed-origin http://localhost[:PORT]]... [--evidence-file PATH] [--runtime-config PATH]".into()),
            _ => return Err("unknown command-line argument".into()),
        }
    }
    let listen = parse_listen_addr(&listen)?;
    let token_file = token_file.ok_or("--token-file is required")?;
    Ok((
        listen,
        token_file.into(),
        origins,
        evidence_file,
        runtime_config,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use ed25519_dalek::SigningKey;
    use tower::ServiceExt;
    use zcanary_core::{Command, encode_memo};

    const TEST_TOKEN: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg_-";

    fn test_app() -> Router {
        app(AgentState::new(TEST_TOKEN.to_vec(), ["http://localhost:3000".to_owned()]).unwrap())
    }

    fn auth_request(uri: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .uri(uri)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn requires_auth_and_rejects_unapproved_origins() {
        let response = test_app()
            .oneshot(
                HttpRequest::builder()
                    .uri("/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let request = HttpRequest::builder()
            .uri("/v1/status")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .header(header::ORIGIN, "http://evil.example")
            .body(Body::empty())
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(
            !response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }

    #[tokio::test]
    async fn unsupported_method_returns_stable_error_with_request_id() {
        let request = HttpRequest::builder()
            .method(Method::DELETE)
            .uri("/v1/status")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .body(Body::empty())
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["error"]["code"], "ERR_METHOD_NOT_ALLOWED");
        assert!(error["error"]["requestId"].as_str().is_some());
    }

    #[test]
    fn bind_and_origin_config_must_be_loopback_only() {
        assert!(parse_listen_addr("127.0.0.1:8787").is_ok());
        assert!(parse_listen_addr("[::1]:8787").is_ok());
        assert!(parse_listen_addr("0.0.0.0:8787").is_err());
        assert!(parse_listen_addr("192.0.2.1:8787").is_err());
        assert!(is_loopback_http_origin("http://localhost:3000"));
        assert!(is_loopback_http_origin("http://[::1]:3000"));
        assert!(!is_loopback_http_origin("https://localhost:3000"));
        assert!(!is_loopback_http_origin("http://localhost.evil:3000"));
        assert!(!is_loopback_http_origin("http://localhost:3000/path"));
    }

    #[tokio::test]
    async fn bounds_request_body_and_reports_stable_status_capabilities() {
        let oversized = vec![b'x'; MAX_REQUEST_BODY + 1];
        let request = HttpRequest::builder()
            .method(Method::POST)
            .uri("/v1/memos/verify")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(oversized))
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = test_app()
            .oneshot(auth_request("/v1/status"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status["network"], "testnet");
        assert_eq!(status["simulation"], false);
        assert_eq!(status["wallet"]["available"], false);
        assert_eq!(status["keepers"]["running"], false);

        let response = test_app()
            .oneshot(auth_request("/v1/evidence"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let evidence: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(evidence["available"], false);
    }

    fn sample_evidence() -> EvidenceReport {
        EvidenceReport {
            version: 1,
            label: "Verified Zcash testnet memo send".into(),
            runs: vec![EvidenceRun {
                label: "testnet memo send".into(),
                mode: EvidenceMode::Testnet,
                checks: vec![EvidenceCheck {
                    name: "memo recovered by view-only scanner".into(),
                    passed: true,
                }],
                transactions: vec![EvidenceTransaction {
                    label: "Shielded memo transaction".into(),
                    txid: "ab".repeat(32),
                    block_height: Some(1234),
                    network: EvidenceNetwork::Testnet,
                }],
                limitations: vec!["The explorer does not reveal shielded memo contents.".into()],
            }],
        }
    }

    #[tokio::test]
    async fn evidence_endpoint_requires_auth_and_returns_only_validated_fields() {
        let state = AgentState::new(TEST_TOKEN.to_vec(), ["http://localhost:3000".to_owned()])
            .unwrap()
            .with_evidence(sample_evidence())
            .unwrap();
        let router = app(state);
        let unauthorized = router
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/v1/evidence")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let response = router.oneshot(auth_request("/v1/evidence")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), MAX_EVIDENCE_FILE_BYTES as usize)
            .await
            .unwrap();
        let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(result["available"], true);
        assert_eq!(result["report"]["version"], 1);
        assert_eq!(result["report"]["runs"][0]["mode"], "testnet");
        assert_eq!(
            result["report"]["runs"][0]["transactions"][0]["txid"],
            "ab".repeat(32)
        );
        assert!(result["report"].get("rawFileContents").is_none());
    }

    #[test]
    fn evidence_schema_rejects_unknown_fields_invalid_txids_and_synthetic_transactions() {
        let mut value = serde_json::to_value(sample_evidence()).unwrap();
        value["unexpectedSecret"] = serde_json::json!("must not be returned");
        assert!(serde_json::from_value::<EvidenceReport>(value).is_err());

        let mut invalid = sample_evidence();
        invalid.runs[0].transactions[0].txid = "not-a-txid".into();
        assert!(validate_evidence_report(&invalid).is_err());

        let mut synthetic = sample_evidence();
        synthetic.runs[0].mode = EvidenceMode::SyntheticChain;
        assert!(validate_evidence_report(&synthetic).is_err());

        let mut wrong_version = sample_evidence();
        wrong_version.version = 2;
        assert!(validate_evidence_report(&wrong_version).is_err());
    }

    #[test]
    fn evidence_file_reader_is_bounded_and_cli_evidence_path_is_optional() {
        let mut path = std::env::temp_dir();
        path.push(format!("zcanary-evidence-{}.json", new_id().unwrap()));
        std::fs::write(&path, serde_json::to_vec(&sample_evidence()).unwrap()).unwrap();
        assert_eq!(
            read_evidence_file(&path).unwrap().runs[0].mode,
            EvidenceMode::Testnet
        );
        std::fs::write(&path, vec![b'x'; MAX_EVIDENCE_FILE_BYTES + 1]).unwrap();
        assert!(
            read_evidence_file(&path)
                .unwrap_err()
                .contains("size limit")
        );
        let _ = std::fs::remove_file(&path);

        let args = vec!["--token-file".into(), "token".into()];
        let parsed = parse_cli_args(args).unwrap();
        assert_eq!(parsed.3, None);
        let args = vec![
            "--token-file".into(),
            "token".into(),
            "--evidence-file".into(),
            "evidence.json".into(),
        ];
        assert_eq!(
            parse_cli_args(args).unwrap().3,
            Some(std::path::PathBuf::from("evidence.json"))
        );
    }

    fn signed_memo() -> (Vec<u8>, [u8; 32]) {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let signing = SigningKey::from_bytes(&seed);
        let command = Command {
            network: 1,
            operation: Operation::Register,
            switch_id: [9; 32],
            sequence: 0,
            requested_expiry_height: 100,
            manifest_digest: [8; 32],
            source_pubkey: signing.verifying_key().to_bytes(),
        };
        (encode_memo(&command, &seed).unwrap().to_vec(), seed)
    }

    #[tokio::test]
    async fn native_routes_are_authenticated_and_never_simulate_missing_runtime() {
        let vault = "ab".repeat(32);
        let operation = "cd".repeat(16);
        let routes = [
            (Method::GET, "/v1/runtime".to_owned()),
            (Method::GET, "/v1/fees".to_owned()),
            (Method::POST, "/v1/runtime/stop".to_owned()),
            (Method::POST, "/v1/recipient/identity".to_owned()),
            (Method::GET, "/v1/recipient/inbox".to_owned()),
            (
                Method::POST,
                format!("/v1/recipient/vaults/{vault}/decrypt"),
            ),
            (Method::GET, "/v1/vaults".to_owned()),
            (Method::POST, "/v1/vaults".to_owned()),
            (Method::GET, format!("/v1/vaults/{vault}")),
            (Method::GET, format!("/v1/vaults/{vault}/events")),
            (Method::GET, format!("/v1/vaults/{vault}/package")),
            (Method::POST, format!("/v1/vaults/{vault}/register")),
            (Method::POST, format!("/v1/vaults/{vault}/postpone")),
            (Method::POST, format!("/v1/vaults/{vault}/cancel")),
            (Method::POST, format!("/v1/vaults/{vault}/provision")),
            (Method::GET, format!("/v1/operations/{operation}")),
            (Method::POST, format!("/v1/operations/{operation}/retry")),
            (Method::GET, "/v1/support-request".to_owned()),
            (Method::POST, "/v1/identity/source/export".to_owned()),
            (Method::POST, "/v1/identity/recipient/import".to_owned()),
        ];
        for (method, path) in routes {
            let unauthenticated = HttpRequest::builder()
                .method(method.clone())
                .uri(&path)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                test_app().oneshot(unauthenticated).await.unwrap().status(),
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
            let mut authenticated = auth_request(&path);
            *authenticated.method_mut() = method;
            let response = test_app().oneshot(authenticated).await.unwrap();
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store"
            );
            let expected = if path == "/v1/runtime" {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            assert_eq!(response.status(), expected, "{path}");
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if path == "/v1/runtime" {
                assert_eq!(value["available"], false);
                assert_eq!(value["wallet"]["available"], false);
                assert_eq!(value["keepers"], serde_json::json!([]));
            } else {
                assert_eq!(value["error"]["code"], "ERR_WALLET_UNAVAILABLE");
            }
        }
    }

    #[test]
    fn native_file_limit_is_scoped_to_configured_create_only() {
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/vaults"),
            MAX_NATIVE_CREATE_BODY
        );
        assert_eq!(
            request_body_limit(false, &Method::POST, "/v1/vaults"),
            MAX_REQUEST_BODY
        );
        for path in [
            "/v1/vaults",
            "/v1/recipient/identity",
            "/v1/memos/verify",
            "/v1/runtime/stop",
        ] {
            assert_eq!(
                request_body_limit(true, &Method::GET, path),
                MAX_REQUEST_BODY
            );
        }
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/vaults/ab/register"),
            MAX_REQUEST_BODY
        );
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/vaults/"),
            MAX_REQUEST_BODY
        );
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/identity/source/import"),
            MAX_IDENTITY_BACKUP_BODY
        );
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/identity/recipient/export"),
            MAX_IDENTITY_BACKUP_BODY
        );
        assert_eq!(
            request_body_limit(false, &Method::POST, "/v1/identity/source/import"),
            MAX_REQUEST_BODY
        );
        assert_eq!(
            request_body_limit(true, &Method::POST, "/v1/identity/wallet/import"),
            MAX_REQUEST_BODY
        );
    }

    #[test]
    fn native_create_schema_rejects_security_overrides_and_runtime_cli_is_optional() {
        let mut value = serde_json::json!({
            "fileName": "evidence.bin", "contentsBase64": "AQID", "recipient": "age1public",
            "recipientFingerprint": "AA:BB", "intervalBlocks": 24, "graceBlocks": 4, "confirmationTarget": 2
        });
        assert!(serde_json::from_value::<NativeCreateRequest>(value.clone()).is_ok());
        value["keeperRecipients"] = serde_json::json!(["untrusted-key"]);
        assert!(serde_json::from_value::<NativeCreateRequest>(value).is_err());
        let basic = parse_cli_args(["--token-file".into(), "token".into()]).unwrap();
        assert!(basic.4.is_none());
        let configured = parse_cli_args([
            "--token-file".into(),
            "token".into(),
            "--runtime-config".into(),
            "runtime.json".into(),
        ])
        .unwrap();
        assert_eq!(configured.4, Some(std::path::PathBuf::from("runtime.json")));
        assert!(
            parse_cli_args([
                "--token-file".into(),
                "token".into(),
                "--runtime-config".into()
            ])
            .is_err()
        );
    }

    #[tokio::test]
    async fn native_routes_report_wrong_methods_as_structured_errors() {
        for path in [
            "/v1/runtime",
            "/v1/fees",
            "/v1/runtime/stop",
            "/v1/recipient/inbox",
            "/v1/vaults/abcd",
            "/v1/operations/abcd/retry",
        ] {
            let mut request = auth_request(path);
            *request.method_mut() = Method::DELETE;
            let response = test_app().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{path}");
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["error"]["code"], "ERR_METHOD_NOT_ALLOWED");
        }
    }

    #[tokio::test]
    async fn verifies_real_memo_and_rejects_bad_signature() {
        let (memo, _) = signed_memo();
        let request_body = serde_json::json!({ "memoHex": hex::encode(&memo) }).to_string();
        let request = HttpRequest::builder()
            .method(Method::POST)
            .uri("/v1/memos/verify")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(request_body))
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(result["verified"], true);
        assert_eq!(result["sequence"], "0");

        let mut bad = memo;
        bad[448] ^= 1;
        let request_body = serde_json::json!({ "memoHex": hex::encode(bad) }).to_string();
        let request = HttpRequest::builder()
            .method(Method::POST)
            .uri("/v1/memos/verify")
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", std::str::from_utf8(TEST_TOKEN).unwrap()),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(request_body))
            .unwrap();
        let response = test_app().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(result["error"]["code"], "ERR_MEMO_INVALID");
        assert!(result["error"]["requestId"].as_str().is_some());
    }
}
