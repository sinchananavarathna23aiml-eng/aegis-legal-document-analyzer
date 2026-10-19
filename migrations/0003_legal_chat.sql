CREATE TABLE IF NOT EXISTS legal_chat_threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  document_text TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legal_chat_threads_user_updated_idx
  ON legal_chat_threads (user_id, updated_at DESC);
