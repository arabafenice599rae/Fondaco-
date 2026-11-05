# syntax=docker/dockerfile:1.7
# MinIO for the backup smoke test only (D-58; never deployed, never published), built from its release tag.
# Pinned: the Go image (version and digest), GOTOOLCHAIN=local (no toolchain download; the tag's go.mod asks go1.24.2 at most),
# the module's h1 hash, the sha256 of the tag's go.sum, and -mod=readonly (every dependency checked against that go.sum).
# The same values are in tools/ci/toolchain.json → minio; the CI passes them as build args and caches the binary
# (stage `bin`) under minio-<version>-go<go>, then builds the runnable image from the cache with Dockerfile.run.
ARG GO_IMAGE=golang:1.24.7-alpine3.22@sha256:fc2cff6625f3c1c92e6c85938ac5bd09034ad0d4bc2dfb08278020b68540dbb5
ARG MINIO_VERSION=RELEASE.2025-09-07T16-13-09Z
ARG GO_VERSION=1.24.7
ARG MINIO_MODULE_SUM=h1:deu0m9BiyqnMbGWfJi1PpVyotSXlDnTmRIme1cUXnxo=
ARG MINIO_GOSUM_SHA256=e81f196b31076aa8928bcf74456d1a9c20113aca174089bc5c7d0642de3b316f

# optional extra CA for a local proxy: docker build --build-context ca=<dir with ca-bundle.crt> (empty by default, as in CI)
FROM scratch AS ca

FROM ${GO_IMAGE} AS build
ARG MINIO_VERSION GO_VERSION MINIO_MODULE_SUM MINIO_GOSUM_SHA256
ENV GOTOOLCHAIN=local GOFLAGS=-mod=readonly CGO_ENABLED=0
RUN --mount=type=bind,from=ca,target=/extra-ca \
    set -eu; if [ -f /extra-ca/ca-bundle.crt ]; then export SSL_CERT_FILE=/extra-ca/ca-bundle.crt; fi; \
    test "$(go env GOVERSION)" = "go${GO_VERSION}" || { echo "Go is $(go env GOVERSION), want go${GO_VERSION}"; exit 1; }; \
    go mod download -json "github.com/minio/minio@${MINIO_VERSION}" > /tmp/mod.json; \
    sum=$(sed -n 's/^\t"Sum": "\(.*\)",$/\1/p' /tmp/mod.json); dir=$(sed -n 's/^\t"Dir": "\(.*\)",$/\1/p' /tmp/mod.json); \
    test "$sum" = "$MINIO_MODULE_SUM" || { echo "module sum $sum, want $MINIO_MODULE_SUM"; exit 1; }; \
    echo "${MINIO_GOSUM_SHA256}  $dir/go.sum" | sha256sum -c -; \
    mkdir -p /out; cd "$dir"; go build -trimpath -o /out/minio .; \
    echo "built from github.com/minio/minio@${MINIO_VERSION} with go${GO_VERSION}; module ${sum}; go.sum sha256 ${MINIO_GOSUM_SHA256}" > /out/SOURCE; \
    /out/minio --version; cat /out/SOURCE

# the binary and its provenance only: `docker buildx build --target bin --output type=local,dest=<dir>` (CI cache)
FROM scratch AS bin
COPY --from=build /out/minio /out/SOURCE /

# runnable image (local default); the CI uses Dockerfile.run on the cached binary, with the same layout
FROM scratch
ARG MINIO_VERSION
LABEL org.opencontainers.image.version="${MINIO_VERSION}" org.opencontainers.image.source="https://github.com/minio/minio"
COPY --from=bin /minio /SOURCE /
WORKDIR /tmp
WORKDIR /data
EXPOSE 9000
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--address", ":9000"]
