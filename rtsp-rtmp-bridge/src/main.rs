mod auth;
mod config;
mod db;
mod error;
mod models;
mod routes;
mod stream;

use std::net::SocketAddr;
use axum::{
    middleware,
    response::Html,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::{
    auth::{login_handler, logout_handler, require_auth_middleware, session_status, SessionStore},
    config::AppConfig,
    stream::manager::StreamManager,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = AppConfig::load();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(&cfg.rust_log))
        .init();

    let pool = db::init_pool(&cfg.database_url).await?;
    let manager = StreamManager::new(pool, cfg.clone());
    let sessions = SessionStore::default();

    let protected_api = Router::new()
        .route("/api/logout", post(logout_handler).with_state(sessions.clone()))
        .merge(routes::streams::router(manager.clone()))
        .layer(middleware::from_fn_with_state(
            sessions.clone(),
            require_auth_middleware,
        ));

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .route("/auth/session", get(session_status).with_state(sessions.clone()))
        .route("/api/login", post(login_handler).with_state(sessions))
        .merge(protected_api)
        .route("/app.js", get(serve_app_js))
        .fallback_service(ServeDir::new("frontend").append_index_html_on_directories(true))
        .route("/", get(serve_index))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = TcpListener::bind(addr).await?;
    info!("rtsp-rtmp-bridge listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(manager))
        .await?;

    Ok(())
}

async fn serve_index() -> Html<&'static str> {
    Html(include_str!("../frontend/index.html"))
}

async fn serve_app_js() -> ([(&'static str, &'static str); 1], &'static str) {
    (
        [("content-type", "application/javascript; charset=utf-8")],
        include_str!("../frontend/app.js"),
    )
}

async fn shutdown_signal(manager: StreamManager) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Shutdown signal received, stopping all active FFmpeg child processes...");
    manager.stop_all().await;
}
