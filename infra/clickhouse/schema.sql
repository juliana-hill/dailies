CREATE TABLE IF NOT EXISTS videos (
  video_id String, channel_id String, title String, published_at DateTime, duration_seconds UInt32
) ENGINE = ReplacingMergeTree ORDER BY (channel_id, video_id);

CREATE TABLE IF NOT EXISTS retention_curve_points (
  video_id String, position_ratio Float32, position_seconds Float32, audience_watch_ratio Float32
) ENGINE = ReplacingMergeTree ORDER BY (video_id, position_ratio);

CREATE TABLE IF NOT EXISTS cut_events (
  video_id String, position_ratio Float32, position_seconds Float32, event_type LowCardinality(String), metadata_json String
) ENGINE = MergeTree ORDER BY (video_id, position_ratio, event_type);

CREATE TABLE IF NOT EXISTS music_segments (
  project_id String, video_id String, start_position_ratio Float32, end_position_ratio Float32,
  start_seconds Float32, end_seconds Float32, mood_tag String, generation_prompt String, asset_id String, created_at DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY (project_id, start_position_ratio);

CREATE TABLE IF NOT EXISTS recommendations (
  project_id String, channel_id String, generated_at DateTime DEFAULT now(), drop_off_position_ratio Float32,
  drop_off_seconds Float32, severity_percent Float32, observed_evidence String, inferred_cause String,
  recommendation_text String, supporting_video_ids Array(String)
) ENGINE = MergeTree ORDER BY (channel_id, generated_at);
