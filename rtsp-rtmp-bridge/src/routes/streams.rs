use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{CreateStreamRequest, UpdateStreamRequest},
    stream::manager::StreamManager,
};

#[derive(Debug, Deserialize, Default)]
pub struct StartStreamBody {
    #[serde(default)]
    pub skip_probe: bool,
}

pub fn router(manager: StreamManager) -> Router {
    Router::new()
        .route("/api/streams", get(list_streams).post(create_stream))
        .route("/api/bandwidth", get(get_bandwidth))
        .route(
            "/api/streams/:id",
            patch(update_stream).delete(delete_stream),
        )
        .route("/api/streams/:id/start", post(start_stream))
        .route("/api/streams/:id/stop", post(stop_stream))
        .route("/api/streams/:id/probe", post(probe_stream))
        .route("/api/streams/:id/logs", get(get_logs))
        .with_state(manager)
}

async fn list_streams(State(manager): State<StreamManager>) -> Result<Json<Value>, AppError> {
    let streams = manager.list_streams().await?;
    Ok(Json(json!({ "streams": streams })))
}

async fn get_bandwidth(State(manager): State<StreamManager>) -> Json<Value> {
    let snapshot = manager.get_bandwidth().await;
    Json(json!(snapshot))
}

async fn create_stream(
    State(manager): State<StreamManager>,
    Json(req): Json<CreateStreamRequest>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let (stream, probe) = manager.create_stream(req).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "stream": stream, "probe": probe })),
    ))
}

async fn update_stream(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateStreamRequest>,
) -> Result<Json<Value>, AppError> {
    let stream = manager.update_stream(id, req).await?;
    Ok(Json(json!({ "stream": stream })))
}

async fn delete_stream(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    manager.delete_stream(id).await?;
    Ok(Json(json!({ "deleted": true, "id": id })))
}

async fn start_stream(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
    body: Option<Json<StartStreamBody>>,
) -> Result<Json<Value>, AppError> {
    let skip_probe = body.map(|b| b.0.skip_probe).unwrap_or(false);
    let stream = manager.start_stream(id, skip_probe).await?;
    Ok(Json(json!({ "stream": stream })))
}

async fn stop_stream(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let stream = manager.stop_stream(id).await?;
    Ok(Json(json!({ "stream": stream })))
}

async fn probe_stream(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let probe = manager.probe_stream(id).await?;
    Ok(Json(json!({ "probe": probe })))
}

async fn get_logs(
    State(manager): State<StreamManager>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let logs = manager.get_logs(id).await?;
    Ok(Json(json!({ "logs": logs })))
}
