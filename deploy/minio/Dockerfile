# syntax=docker/dockerfile:1.7
# MinIO for the backup smoke test only (D-58; never deployed, never published).
#   1. First choice: the release binary from dl.min.io, verified against its .sha256sum.
#   2. Fallback, if the download or the check fails: built from the same release tag with `go install`, verified by the Go
#      checksum database. On 2026-11-04 dl.min.io answers 410 Gone for every community release, so today the fallback runs.
# The image records which path was taken in /SOURCE (read by the smoke test). MINIO_IMAGE=<ref@sha256:…> makes the smoke
# test use a ready image instead (e.g. quay.io/minio/minio if it becomes pullable anonymously again: see the CI probe).
ARG GO_IMAGE=golang:1.24.7-alpine3.22@sha256:fc2cff6625f3c1c92e6c85938ac5bd09034ad0d4bc2dfb08278020b68540dbb5
ARG MINIO_VERSION=RELEASE.2025-09-07T16-13-09Z

# optional extra CA for a local proxy: docker build --build-context ca=<dir with ca-bundle.crt> (empty by default, as in CI)
FROM scratch AS ca

FROM ${GO_IMAGE} AS build
ARG MINIO_VERSION
RUN --mount=type=bind,from=ca,target=/extra-ca \
    set -u; mkdir -p /out; \
    if [ -f /extra-ca/ca-bundle.crt ]; then export SSL_CERT_FILE=/extra-ca/ca-bundle.crt; fi; \
    url="https://dl.min.io/server/minio/release/linux-amd64/archive/minio.${MINIO_VERSION}"; \
    if wget -q -O /out/minio "$url" && wget -q -O /tmp/minio.sha256sum "$url.sha256sum" \
       && [ "$(cut -d' ' -f1 /tmp/minio.sha256sum)" = "$(sha256sum /out/minio | cut -d' ' -f1)" ]; then \
      echo "dl.min.io binary, sha256 $(cut -d' ' -f1 /tmp/minio.sha256sum) verified" > /out/SOURCE; \
    else \
      echo "dl.min.io unavailable or checksum mismatch: building from the release tag"; rm -f /out/minio; \
      CGO_ENABLED=0 GOBIN=/out go install -trimpath "github.com/minio/minio@${MINIO_VERSION}" \
      && echo "go install github.com/minio/minio@${MINIO_VERSION} (dl.min.io unavailable)" > /out/SOURCE; \
    fi; \
    chmod +x /out/minio && /out/minio --version && cat /out/SOURCE

FROM scratch
ARG MINIO_VERSION
LABEL org.opencontainers.image.version="${MINIO_VERSION}" org.opencontainers.image.source="https://github.com/minio/minio"
COPY --from=build /out/minio /minio
COPY --from=build /out/SOURCE /SOURCE
COPY --from=build /tmp /tmp
WORKDIR /data
EXPOSE 9000
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--address", ":9000"]
