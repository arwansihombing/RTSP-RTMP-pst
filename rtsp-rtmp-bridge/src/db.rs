use chrono::Utc;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use uuid::Uuid;

use crate::{error::AppError, models::StreamRecord};

pub async fn init_pool(database_url: &str) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub async fn list_streams(pool: &SqlitePool) -> Result<Vec<StreamRecord>, AppError> {
    let rows = sqlx::query_as::<_, StreamRecord>(
        "SELECT id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at
         FROM streams
         ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn get_stream(pool: &SqlitePool, id: Uuid) -> Result<Option<StreamRecord>, AppError> {
    let row = sqlx::query_as::<_, StreamRecord>(
        "SELECT id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at
         FROM streams
         WHERE id = ?",
    )
    .bind(id.to_string())
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

pub async fn insert_stream(
    pool: &SqlitePool,
    name: &str,
    rtsp_url: &str,
    rtmp_url: &str,
    enabled: bool,
) -> Result<StreamRecord, AppError> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let enabled_int: i64 = if enabled { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO streams (id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name.trim())
    .bind(rtsp_url.trim())
    .bind(rtmp_url.trim())
    .bind(enabled_int)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    let created = sqlx::query_as::<_, StreamRecord>(
        "SELECT id, name, rtsp_url, rtmp_url, enabled, created_at, updated_at
         FROM streams
         WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;

    Ok(created)
}

pub async fn update_stream(
    pool: &SqlitePool,
    id: Uuid,
    name: Option<&str>,
    rtsp_url: Option<&str>,
    rtmp_url: Option<&str>,
    enabled: Option<bool>,
) -> Result<Option<StreamRecord>, AppError> {
    let Some(existing) = get_stream(pool, id).await? else {
        return Ok(None);
    };

    let next_name = name.map(|s| s.trim().to_string()).unwrap_or(existing.name);
    let next_rtsp = rtsp_url.map(|s| s.trim().to_string()).unwrap_or(existing.rtsp_url);
    let next_rtmp = rtmp_url.map(|s| s.trim().to_string()).unwrap_or(existing.rtmp_url);
    let next_enabled = enabled.map(|b| if b { 1 } else { 0 }).unwrap_or(existing.enabled);
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE streams
         SET name = ?, rtsp_url = ?, rtmp_url = ?, enabled = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&next_name)
    .bind(&next_rtsp)
    .bind(&next_rtmp)
    .bind(next_enabled)
    .bind(&now)
    .bind(id.to_string())
    .execute(pool)
    .await?;

    get_stream(pool, id).await
}

pub async fn delete_stream(pool: &SqlitePool, id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM streams WHERE id = ?")
        .bind(id.to_string())
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}
