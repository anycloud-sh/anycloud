-- Add base_image_id to VMs table for pre-baked image isolation (GPU vs non-GPU)
ALTER TABLE vms ADD COLUMN base_image_id TEXT;
