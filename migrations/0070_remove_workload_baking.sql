-- Remove the customer workload-image baking runtime contract.
--
-- A process interrupted in the old Baking step cannot resume that step after
-- this release. Move it into the normal retry pipeline first. The retried
-- deployment will provision from its ordinary base image and pull the image.
-- Existing deployment_events rows are immutable audit history and intentionally
-- retain their original `baking` state/metadata.
INSERT INTO deployment_events (deployment_id, state, metadata, created_at)
SELECT id,
       'retrying',
       '{"reason":"workload image baking removed"}',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM deployments
WHERE state = 'baking';

UPDATE deployments
SET state = 'retrying',
    next_check_at = NULL
WHERE state = 'baking';

ALTER TABLE deployments DROP COLUMN bake;
ALTER TABLE deployments DROP COLUMN use_bake_cache;
ALTER TABLE deployments DROP COLUMN warm_image;
ALTER TABLE vms DROP COLUMN base_image_family;
ALTER TABLE vms DROP COLUMN prebaked_image_id;
