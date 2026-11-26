CREATE TABLE tool_check (
    db TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tool_check (db) VALUES (current_database());
