-- migrations/0005_add_preempted.sql
-- Add preempted column to track spot instance preemption

ALTER TABLE vm_ips ADD COLUMN preempted INTEGER DEFAULT 0;
