BEGIN;

LOCK TABLE
  sciforge_collaboration.projects,
  sciforge_collaboration.resource_refs,
  sciforge_collaboration.tasks
IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'resource_refs_project_resource_unique'
      AND conrelid = 'sciforge_collaboration.resource_refs'::regclass
  ) THEN
    ALTER TABLE sciforge_collaboration.resource_refs
      ADD CONSTRAINT resource_refs_project_resource_unique UNIQUE (project_id, resource_ref_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS sciforge_collaboration.project_content_space_bindings (
  project_id text PRIMARY KEY,
  root_resource_ref_id text NOT NULL,
  root_reference_digest bytea NOT NULL,
  status text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT project_content_space_bindings_status_valid CHECK (status IN ('active', 'closed')),
  CONSTRAINT project_content_space_bindings_revision_valid CHECK (revision >= 1),
  CONSTRAINT project_content_space_bindings_root_digest_valid CHECK (octet_length(root_reference_digest) = 32),
  CONSTRAINT project_content_space_bindings_project_fk FOREIGN KEY (project_id)
    REFERENCES sciforge_collaboration.projects(project_id) ON DELETE CASCADE,
  CONSTRAINT project_content_space_bindings_root_fk FOREIGN KEY (project_id, root_resource_ref_id)
    REFERENCES sciforge_collaboration.resource_refs(project_id, resource_ref_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS project_content_space_bindings_active_root_unique
  ON sciforge_collaboration.project_content_space_bindings(root_reference_digest)
  WHERE status = 'active';

ALTER TABLE sciforge_collaboration.tasks
  ADD COLUMN IF NOT EXISTS file_intent jsonb;

ALTER TABLE sciforge_collaboration.tasks
  DROP CONSTRAINT IF EXISTS tasks_file_intent_shape;

ALTER TABLE sciforge_collaboration.tasks
  ADD CONSTRAINT tasks_file_intent_shape CHECK (
    file_intent IS NULL OR (
      jsonb_typeof(file_intent) = 'object'
      AND file_intent ?& ARRAY['schemaVersion', 'bindingRevision', 'inputs', 'output']
      AND file_intent - ARRAY['schemaVersion', 'bindingRevision', 'inputs', 'output'] = '{}'::jsonb
      AND file_intent ->> 'schemaVersion' = '1'
      AND jsonb_typeof(file_intent -> 'bindingRevision') = 'number'
      AND (file_intent ->> 'bindingRevision') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(file_intent -> 'inputs') = 'array'
      AND jsonb_array_length(file_intent -> 'inputs') BETWEEN 1 AND 100
      AND jsonb_typeof(file_intent -> 'output') = 'object'
      AND file_intent -> 'output' ?& ARRAY['containerResourceRefId', 'mode']
      AND (file_intent -> 'output') - ARRAY['containerResourceRefId', 'mode'] = '{}'::jsonb
      AND file_intent -> 'output' ->> 'mode' = 'upload-new'
      AND file_intent -> 'output' ->> 'containerResourceRefId' ~ '^rrf_[A-Za-z0-9][A-Za-z0-9_]{10,62}[A-Za-z0-9]$'
    )
  );

INSERT INTO sciforge_collaboration.schema_migrations(version)
VALUES (10)
ON CONFLICT (version) DO NOTHING;

COMMIT;
