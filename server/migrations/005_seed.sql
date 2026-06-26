-- local org root actor (org is its own org_id)
INSERT INTO actor (id, kind, handle, display_name, org_id, status)
VALUES ('00000000-0000-7000-8000-00000000c0de', 'org', 'org', 'Local Org',
        '00000000-0000-7000-8000-00000000c0de', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO event_type (id, namespace, name, version, schema, owner) VALUES
('00000000-0000-7000-8000-000000000101','identity','actor.registered',1,
 '{"type":"object","additionalProperties":true,"required":["handle","display_name","kind","email"],"properties":{"handle":{"type":"string","minLength":1},"display_name":{"type":"string","minLength":1},"kind":{"type":"string","enum":["human","ai","device","org","project","workflow"]},"email":{"type":"string","format":"email"}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000102','identity','role.granted',1,
 '{"type":"object","additionalProperties":true,"required":["role"],"properties":{"role":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000103','identity','role.revoked',1,
 '{"type":"object","additionalProperties":true,"required":["role"],"properties":{"role":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000201','chat','thread.created',1,
 '{"type":"object","additionalProperties":true,"required":["title"],"properties":{"title":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000202','chat','message.posted',1,
 '{"type":"object","additionalProperties":true,"required":["body"],"properties":{"body":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000203','chat','message.edited',1,
 '{"type":"object","additionalProperties":true,"required":["body"],"properties":{"body":{"type":"string","minLength":1},"edits_event_id":{"type":"string"}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000204','chat','message.deleted',1,
 '{"type":"object","additionalProperties":true,"properties":{}}'::jsonb,'core')
ON CONFLICT DO NOTHING;

INSERT INTO projection_checkpoint (name, last_event_seq) VALUES
('identity', 0), ('chat', 0) ON CONFLICT DO NOTHING;
