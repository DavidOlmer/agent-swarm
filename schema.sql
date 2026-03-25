CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'code',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 2,
  description TEXT NOT NULL,
  input TEXT,
  output TEXT,
  agent_id TEXT,
  error TEXT,
  parent_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority, status);

-- Feedback: human ratings on agent outputs
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  rating INTEGER NOT NULL,            -- 1-5 stars
  feedback_type TEXT NOT NULL DEFAULT 'quality',  -- 'quality', 'accuracy', 'speed'
  comment TEXT,
  reviewer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_task ON feedback(task_id);

-- Learnings: extracted patterns from successful/failed tasks
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,           -- 'code', 'test', etc.
  pattern_type TEXT NOT NULL,         -- 'success', 'failure', 'correction'
  description TEXT NOT NULL,          -- What was learned
  context TEXT,                       -- JSON: task description pattern, input characteristics
  frequency INTEGER NOT NULL DEFAULT 1,  -- How often this pattern has been seen
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learnings_agent ON learnings(agent_type);
CREATE INDEX IF NOT EXISTS idx_learnings_frequency ON learnings(frequency DESC);

-- Agent runs: track performance + reliability metrics per execution
-- Based on Narayanan & Kapoor "Towards a Science of AI Agent Reliability" (2026)
-- 4 dimensions: Consistency, Robustness, Predictability, Safety
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT,
  -- Consistency metrics (C_res: resource usage)
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  duration_ms INTEGER,
  cost_usd REAL DEFAULT 0,
  -- Robustness (R_fault: resilience)
  retry_count INTEGER DEFAULT 0,
  -- Predictability (P_cal: confidence calibration)
  confidence REAL,                    -- Agent's stated confidence 0-1
  outcome INTEGER DEFAULT 0,         -- 1=success, 0=failure (for calibration)
  -- Safety (S_comp + S_harm)
  constraint_violations TEXT,         -- JSON array of violations
  violation_severity TEXT DEFAULT 'none',  -- 'none', 'low', 'medium', 'high'
  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'started',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_type ON agent_runs(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_runs_outcome ON agent_runs(agent_type, outcome);

-- User credentials: OAuth tokens and API keys per user per provider
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- 'openai', 'anthropic', 'workers-ai'
  credential_type TEXT NOT NULL,       -- 'api_key', 'oauth_token'
  access_token TEXT,                   -- encrypted API key or OAuth access token
  refresh_token TEXT,                  -- OAuth refresh token
  token_expires_at TEXT,               -- OAuth token expiry
  scopes TEXT,                         -- OAuth scopes granted
  metadata TEXT,                       -- JSON: org_id, account name, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_user_provider ON credentials(user_id, provider);
