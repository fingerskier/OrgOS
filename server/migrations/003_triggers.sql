CREATE OR REPLACE FUNCTION event_validate() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  SELECT schema INTO s FROM event_type WHERE id = NEW.event_type_id;
  IF s IS NULL THEN
    RAISE EXCEPTION 'unknown event_type %', NEW.event_type_id USING ERRCODE = 'P0001';
  END IF;
  -- pg_jsonschema signature is jsonb_matches_schema(schema json, instance jsonb);
  -- event_type.schema is jsonb, so cast s::json (VERIFIED — passing jsonb errors "function does not exist").
  -- Schema-qualify as public.jsonb_matches_schema: the extension installs into public, but
  -- integration tests run with search_path = <test_schema> only (no public), so an unqualified
  -- call would error "function does not exist" inside a test schema (VERIFIED empirically).
  -- The SELECT above stays unqualified so it resolves event_type in the caller's schema.
  IF NOT public.jsonb_matches_schema(s::json, NEW.payload) THEN
    RAISE EXCEPTION 'payload fails schema for %.%@%', NEW.namespace, NEW.name, NEW.version
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_validate_trg BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_validate();

CREATE OR REPLACE FUNCTION event_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events', NEW.seq::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify_trg AFTER INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_notify();
