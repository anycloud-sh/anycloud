-- Track the prebaked cloud image each VM actually booted from, if any.
-- downloadStep uses this to decide whether docker pull is needed — fixes a
-- race where getPrebakedImage() was consulted twice (at createVM and again
-- at downloadStep) and could disagree if a concurrent deployment's bake
-- published between the two calls.
ALTER TABLE vms ADD COLUMN prebaked_image_id TEXT;
