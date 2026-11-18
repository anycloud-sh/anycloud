-- Add base_image_family to vms: AnyCloud-owned short family discriminator
-- (e.g. 'gpu-ubuntu22', 'cpu-ubuntu22') used as the prebake filter key.
-- Separate from base_image_id (concrete AMI/offer ID, kept for provenance)
-- because weekly DLAMI rotation changes base_image_id but not the family.
ALTER TABLE vms ADD COLUMN base_image_family TEXT;
