-- A VM Job's own AWS gp3 root volume performance (`--disk-iops`,
-- `--disk-throughput`), overriding its disk tier's.
ALTER TABLE workloads ADD COLUMN disk_iops INTEGER;
ALTER TABLE workloads ADD COLUMN disk_throughput_mibps INTEGER;
