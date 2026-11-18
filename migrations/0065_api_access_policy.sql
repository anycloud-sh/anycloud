CREATE TABLE api_access_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_user TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
