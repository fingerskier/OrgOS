CREATE TABLE actor (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL,
  handle        text        NOT NULL,
  display_name  text        NOT NULL,
  org_id        uuid        NOT NULL,
  public_key    text,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (org_id, handle)
);

CREATE TABLE event_type (
  id          uuid        PRIMARY KEY,
  namespace   text        NOT NULL,
  name        text        NOT NULL,
  version     int         NOT NULL,
  schema      jsonb       NOT NULL,
  owner       text,
  status      text        NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, name, version)
);

CREATE TABLE event (
  id             uuid        PRIMARY KEY,
  seq            bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_type_id  uuid        NOT NULL REFERENCES event_type(id),
  namespace      text        NOT NULL,
  name           text        NOT NULL,
  version        int         NOT NULL,
  actor_id       uuid        NOT NULL,
  org_id         uuid        NOT NULL,
  subject_id     uuid,
  stream_id      uuid,
  stream_seq     bigint,
  payload        jsonb       NOT NULL,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  signature      text,
  UNIQUE (stream_id, stream_seq)
);
CREATE INDEX event_subject_idx ON event (subject_id, seq);
CREATE INDEX event_ns_name_idx ON event (namespace, name, seq);
CREATE INDEX event_stream_idx  ON event (stream_id, stream_seq);

CREATE TABLE projection_checkpoint (
  name            text        PRIMARY KEY,
  last_event_seq  bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- operational, ephemeral; NOT event-sourced (auth plumbing)
CREATE TABLE login_token (
  token_hash  text        PRIMARY KEY,
  email       text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_token_email_idx ON login_token (email);
