-- GPU runtime the image base layer expects, inferred from its config blob at
-- submit (cuda / rocm / unknown). Lets the optimizer drop accelerators the image
-- can't run on (e.g. a CUDA image on an AMD MI300X) without re-inspecting the
-- image at conduct. NULL for legacy rows and rows where it could not be detected.
-- Insert-only -- set when the deployment row is created, never updated.
ALTER TABLE deployments ADD COLUMN image_runtime TEXT;
