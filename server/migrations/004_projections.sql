CREATE TABLE actor_state (
  actor_id        uuid    PRIMARY KEY,
  handle          text    NOT NULL,
  display_name    text    NOT NULL,
  kind            text    NOT NULL,
  status          text    NOT NULL,
  email           text    UNIQUE,
  roles           text[]  NOT NULL DEFAULT '{}',
  last_event_seq  bigint  NOT NULL
);

CREATE TABLE chat_thread (
  thread_id       uuid        PRIMARY KEY,
  title           text        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL,
  last_event_seq  bigint      NOT NULL
);

CREATE TABLE chat_message (
  message_id      uuid        PRIMARY KEY,
  thread_id       uuid        NOT NULL,
  author_id       uuid        NOT NULL,
  body            text        NOT NULL,
  posted_at       timestamptz NOT NULL,
  edited_at       timestamptz,
  deleted         boolean     NOT NULL DEFAULT false,
  last_event_seq  bigint      NOT NULL
);
CREATE INDEX chat_message_thread_idx ON chat_message (thread_id, posted_at);
