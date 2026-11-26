use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::RwLock;
use uuid::Uuid;

pub const SESSION_COOKIE_NAME: &str = "sb_session";
pub const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const ADMIN_USERNAME: &str = "admin";
const ADMIN_PASSWORD: &str = "smkbisa!!*&";

#[derive(Clone, Default)]
pub struct SessionStore {
    sessions: Arc<RwLock<HashMap<String, Instant>>>,
}

impl SessionStore {
    pub async fn create_session(&self) -> String {
        let now = Instant::now();
        let token = Uuid::new_v4().to_string();
        let mut guard = self.sessions.write().await;
        guard.retain(|_, exp| *exp > now);
        guard.insert(token.clone(), now + SESSION_TTL);
        token
    }

    pub async fn is_valid(&self, token: Option<&str>) -> bool {
        let Some(tok) = token else {
            return false;
        };
        let now = Instant::now();
        let mut guard = self.sessions.write().await;
        match guard.get(tok).copied() {
            Some(exp) if exp > now => true,
            Some(_) => {
                guard.remove(tok);
                false
            }
            None => false,
        }
    }

    pub async fn delete_session(&self, token: Option<&str>) {
        if let Some(tok) = token {
            self.sessions.write().await.remove(tok);
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

pub fn extract_all_session_tokens(req: &Request<Body>) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(auth_val) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let trimmed = auth_val.trim();
        if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
            let tok = trimmed[7..].trim();
            if !tok.is_empty() {
                tokens.push(tok.to_string());
            }
        }
    }
    if let Some(cookie_header) = req.headers().get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in cookie_header.split(';') {
            if let Some((k, v)) = part.split_once('=') {
                if k.trim() == SESSION_COOKIE_NAME {
                    let tok = v.trim().to_string();
                    if !tok.is_empty() && !tokens.contains(&tok) {
                        tokens.push(tok);
                    }
                }
            }
        }
    }
    tokens
}

pub async fn resolve_valid_session_token(
    store: &SessionStore,
    req: &Request<Body>,
) -> Option<String> {
    for token in extract_all_session_tokens(req) {
        if store.is_valid(Some(&token)).await {
            return Some(token);
        }
    }
    None
}

fn build_session_cookie(token: &str, max_age_secs: u64) -> String {
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}"
    )
}

pub async fn session_status(
    State(store): State<SessionStore>,
    req: Request<Body>,
) -> impl IntoResponse {
    let authenticated = resolve_valid_session_token(&store, &req).await.is_some();
    Json(json!({ "authenticated": authenticated }))
}

pub async fn login_handler(
    State(store): State<SessionStore>,
    Json(payload): Json<LoginRequest>,
) -> Response {
    if payload.username.trim() != ADMIN_USERNAME || payload.password != ADMIN_PASSWORD {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Username atau password salah" })),
        )
            .into_response();
    }

    let token = store.create_session().await;
    let cookie = build_session_cookie(&token, SESSION_TTL.as_secs());
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true, "username": ADMIN_USERNAME, "token": token })),
    )
        .into_response()
}

pub async fn logout_handler(State(store): State<SessionStore>, req: Request<Body>) -> Response {
    for token in extract_all_session_tokens(&req) {
        store.delete_session(Some(&token)).await;
    }
    let cookie = build_session_cookie("", 0);
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

pub async fn require_auth_middleware(
    State(store): State<SessionStore>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.uri().path() == "/api/login" && req.method() == axum::http::Method::POST {
        return Ok(next.run(req).await);
    }

    if resolve_valid_session_token(&store, &req).await.is_none() {
        return Ok((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized" })),
        )
            .into_response());
    }

    Ok(next.run(req).await)
}
