-- Additional hosted API users authenticate by immutable GitHub account ID.
-- Usernames are display metadata and are refreshed after successful auth.
CREATE TABLE api_access_users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL
);
