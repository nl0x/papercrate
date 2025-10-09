# syntax=docker/dockerfile:1

FROM rust:1-slim AS builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        libssl-dev \
        libpq-dev \
        libjpeg-dev \
        libpng-dev \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
COPY tests ./tests
COPY diesel.toml ./

RUN cargo build --release --bin backend --bin worker --bin webdav
RUN cargo install diesel_cli --no-default-features --features postgres

FROM debian:trixie-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libssl3 \
        libpq5 \
        libjpeg62-turbo \
        libpng16-16 \
        ocrmypdf \
        tesseract-ocr \
        ghostscript \
        qpdf \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/lib \
    && curl -fsSL https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-arm64.tgz -o /tmp/pdfium.tgz \
    && mkdir -p /tmp/pdfium \
    && tar -xzf /tmp/pdfium.tgz -C /tmp/pdfium --strip-components=1 \
    && pdfium_so="$(find /tmp/pdfium -name libpdfium.so -type f | head -n1)" \
    && [ -n "${pdfium_so}" ] \
    && mv "${pdfium_so}" /usr/local/lib/libpdfium.so \
    && ldconfig \
    && rm -rf /tmp/pdfium.tgz /tmp/pdfium \
    && useradd --system --create-home --uid 10001 appuser

COPY --from=builder /app/target/release/backend /usr/local/bin/papercrate-backend
COPY --from=builder /app/target/release/worker /usr/local/bin/papercrate-worker
COPY --from=builder /app/target/release/webdav /usr/local/bin/papercrate-webdav
COPY --from=builder /usr/local/cargo/bin/diesel /usr/local/bin/diesel
COPY migrations ./migrations
COPY diesel.toml ./

ENV RUST_LOG=info
USER appuser
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/papercrate-backend"]
