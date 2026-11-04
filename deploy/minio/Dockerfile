# syntax=docker/dockerfile:1.7
# MinIO for the backup smoke test only (D-58; never deployed, never published). MinIO no longer distributes public images:
# quay.io/minio/minio refuses anonymous pulls and minio/minio is gone from Docker Hub. So the server is built from its
# release tag, verified by the Go checksum database (go install module@version), on a Go image pinned by digest.
# MINIO_IMAGE=<registry ref@sha256:…> makes the smoke test use a ready image instead (e.g. a mirror with credentials).
ARG GO_IMAGE=golang:1.24.7-alpine3.22@sha256:fc2cff6625f3c1c92e6c85938ac5bd09034ad0d4bc2dfb08278020b68540dbb5
ARG MINIO_VERSION=RELEASE.2025-09-07T16-13-09Z

# optional extra CA for a local proxy: docker build --build-context ca=<dir with ca-bundle.crt> (empty by default, as in CI)
FROM scratch AS ca

FROM ${GO_IMAGE} AS build
ARG MINIO_VERSION
RUN --mount=type=bind,from=ca,target=/extra-ca \
    if [ -f /extra-ca/ca-bundle.crt ]; then export SSL_CERT_FILE=/extra-ca/ca-bundle.crt; fi; \
    CGO_ENABLED=0 GOBIN=/out go install -trimpath "github.com/minio/minio@${MINIO_VERSION}" && /out/minio --version

FROM scratch
ARG MINIO_VERSION
LABEL org.opencontainers.image.version="${MINIO_VERSION}" org.opencontainers.image.source="https://github.com/minio/minio"
COPY --from=build /out/minio /minio
COPY --from=build /tmp /tmp
WORKDIR /data
EXPOSE 9000
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--address", ":9000"]
