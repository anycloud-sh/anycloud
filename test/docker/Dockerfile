FROM mirror.gcr.io/library/nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913

# Pad to ~10 GB across two layers to simulate a realistic multi-layer large image.
# Random data is incompressible so layers are large both on disk and over the wire.
RUN dd if=/dev/urandom of=/padding1 bs=1M count=5120
RUN dd if=/dev/urandom of=/padding2 bs=1M count=5120
