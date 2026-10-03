# syntax=docker/dockerfile:1
# Keep builder and runtime on the same Debian release for glibc compatibility.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY admin ./admin
RUN cargo build --release --locked --bin aiw-kb-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 aiw \
    && useradd --uid 10001 --gid aiw --no-create-home aiw \
    && mkdir /data && chown aiw:aiw /data
COPY --from=build /src/target/release/aiw-kb-server /usr/local/bin/aiw-kb-server
ENV AIW_KB_BIND=0.0.0.0:8787 \
    AIW_KB_DATA_DIR=/data \
    AIW_KB_CONFIG=/data/config.toml
WORKDIR /data
USER 10001:10001
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent --show-error "http://${AIW_KB_HEALTH_ADDRESS:-127.0.0.1:8787}/health" || exit 1
ENTRYPOINT ["/usr/local/bin/aiw-kb-server"]
