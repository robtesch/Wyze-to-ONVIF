ARG BUILD_FROM=node:22-alpine
FROM ${BUILD_FROM}

# dhclient  - pulls a DHCP lease for each virtual camera interface
# nftables  - drops the ARP replies the macvlan interfaces would otherwise send
#             for the host's own IP (ARP flux -> UniFi "IP conflict"), via the
#             nft `arp` family. We can't use the arp_ignore sysctl: host-network
#             containers get a read-only /proc/sys. nft only needs NET_ADMIN.
#             (arptables isn't packaged for Alpine; nftables is.) See run.sh.
# HA Supervisor builds add-ons from its own ghcr.io/home-assistant/base image
# regardless of build_from in build.yaml, so Node/npm aren't guaranteed to be
# present from the FROM base — install them explicitly (no-op if already there).
# Node is pinned to Alpine 3.20 (Node 20 LTS): upstream uses util.isDate,
# which was removed in Node 23+, so the base repo's current nodejs crashes.
RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/v3.20/main dhclient nftables \
    && echo "@node320 https://dl-cdn.alpinelinux.org/alpine/v3.20/main" >> /etc/apk/repositories \
    && (command -v npm >/dev/null 2>&1 || apk add --no-cache nodejs@node320 npm@node320)

ENV NODE_ENV=production
WORKDIR /app

# dlo747/RTSP-to-ONVIF-Unifi-Protect, pinned to main as of 2026-07-09
ARG UPSTREAM_SHA=fcdbcf9f624bd00c874bc00b6b5a07a77ec4f536
RUN wget -qO /tmp/upstream.tar.gz "https://github.com/dlo747/RTSP-to-ONVIF-Unifi-Protect/archive/${UPSTREAM_SHA}.tar.gz" \
    && tar -xzf /tmp/upstream.tar.gz -C /app --strip-components=1 \
    && rm /tmp/upstream.tar.gz

# Patched copy of the pinned upstream file: adds per-camera static-IP support
# (assign a fixed IPv4 instead of DHCP). Re-check it if UPSTREAM_SHA changes.
COPY config-tools.js /app/src/config-tools.js

# Add the read-only ONVIF operations requested by Protect. The patch checks the
# pinned source hash and fails the build if upstream changes unexpectedly.
COPY patch-onvif-server.cjs /tmp/patch-onvif-server.cjs
RUN node /tmp/patch-onvif-server.cjs /app/src/onvif-server.js \
    && rm /tmp/patch-onvif-server.cjs

COPY rtsp-debug.cjs /app/rtsp-debug.cjs
COPY patch-proxy-debug.cjs /tmp/patch-proxy-debug.cjs
RUN node /tmp/patch-proxy-debug.cjs /app/main.js \
    && rm /tmp/patch-proxy-debug.cjs

RUN npm ci --omit=dev --silent

COPY ha-config.js /ha-config.js
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
