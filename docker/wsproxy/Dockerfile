# Neon's official WebSocket<->TCP proxy, built from source at a pinned commit.
#
# Why build instead of pull: the prebuilt images (ghcr.io/neondatabase/wsproxy,
# ghcr.io/neondatabase/neon_local) are not anonymously pullable (verified
# 2026-08-07: `denied` on every tag tried). And why the official proxy rather
# than a hand-rolled Node bridge: this is the exact transport the
# @neondatabase/serverless driver speaks against real Neon (same framing, same
# `?address=` contract, same close semantics), so a local test through it
# exercises the same code path a Vercel deploy will — a home-grown bridge could
# only prove itself.
#
# Used only by the `neon` compose profile (docker-compose.yml `neon-proxy`
# service); a default `docker compose up -d` never builds or starts this.
FROM golang:1.24-alpine AS build

RUN apk add --no-cache git

# Pinned so the build is reproducible; bump deliberately, with a rebuild.
ARG WSPROXY_COMMIT=99ed92dd75ba625d03c8d0bd1b09f8ccfe42916a
RUN git clone https://github.com/neondatabase/wsproxy.git /src \
	&& git -C /src checkout "${WSPROXY_COMMIT}"

WORKDIR /src
RUN go build -o /wsproxy .

FROM alpine:3.22
COPY --from=build /wsproxy /usr/local/bin/wsproxy
# LISTEN_PORT / ALLOW_ADDR_REGEX etc. are set by the compose service.
CMD ["wsproxy"]
