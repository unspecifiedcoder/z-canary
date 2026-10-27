use std::env;

use zcanary_agent::runtime::Runtime;
use zcanary_agent::{AgentState, app, parse_cli_args, read_evidence_file, read_token_file};

#[tokio::main]
async fn main() {
    let (listen, token_path, origins, evidence_path, runtime_path) =
        match parse_cli_args(env::args().skip(1)) {
            Ok(parsed) => parsed,
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(2);
            }
        };
    let token = match read_token_file(&token_path) {
        Ok(token) => token,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let state = match AgentState::new(token, origins) {
        Ok(state) => state,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let state = match evidence_path {
        Some(path) => {
            match read_evidence_file(&path).and_then(|report| state.with_evidence(report)) {
                Ok(state) => state,
                Err(message) => {
                    eprintln!("{message}");
                    std::process::exit(2);
                }
            }
        }
        None => state,
    };
    // Bind first so a port conflict cannot leave newly spawned keeper processes behind.
    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(listener) => listener,
        Err(_) => {
            eprintln!("could not bind loopback listener");
            std::process::exit(1);
        }
    };
    let runtime = match runtime_path {
        Some(path) => match tokio::task::spawn_blocking(move || Runtime::start(&path)).await {
            Ok(Ok(runtime)) => Some(runtime),
            _ => {
                eprintln!(
                    "native runtime could not start; check its local configuration and wallet availability"
                );
                std::process::exit(1);
            }
        },
        None => None,
    };
    let state = match &runtime {
        Some(runtime) => state.with_runtime(runtime.clone()),
        None => state,
    };
    let shutdown_runtime = runtime.clone();
    let result = axum::serve(listener, app(state))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            if let Some(runtime) = shutdown_runtime {
                let _ = tokio::task::spawn_blocking(move || runtime.stop()).await;
            }
        })
        .await;
    if let Some(runtime) = runtime {
        runtime.stop();
    }
    if result.is_err() {
        eprintln!("agent server stopped with an error");
        std::process::exit(1);
    }
}
