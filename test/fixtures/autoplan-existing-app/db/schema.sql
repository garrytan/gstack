CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL
);
CREATE TABLE activity (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, created_at BIGINT NOT NULL, read_at BIGINT
);
CREATE INDEX activity_user_created ON activity(user_id, created_at);
CREATE INDEX notifications_user_created ON notifications(user_id, created_at);
