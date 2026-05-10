# logtura-forwarder
#
# A "kitchen-sink" Vector container with the CLIs our generated
# vector.yaml configs typically shell out to via `exec` sources:
# wrangler (Cloudflare Workers tail), flyctl (Fly logs), gcloud
# (GCP Cloud Logging), aws (CloudWatch Logs), plus python for any
# small adapter scripts.
#
# Single image for all customers — the per-customer vector.yaml is
# injected at runtime via the deploy target's file-mount mechanism
# (e.g. Fly's config.files). When a future provider needs a CLI we
# don't already ship, we add it here and rebuild — no per-customer
# image build needed.
#
# Built and pushed by .github/workflows/build-forwarder.yml on every
# push to main that touches this directory. Public image at
# ghcr.io/q32llc/logtura-forwarder:latest.

FROM timberio/vector:latest-debian

ARG NODE_MAJOR=20

# Common system tools + curl for downloading installers + python
# for ad-hoc adapter scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      jq \
      python3 \
      python3-pip \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js (NodeSource) — needed for wrangler. Pinned major to keep
# image hashes reproducible across rebuilds within a quarter.
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Cloudflare Wrangler — used by Vector exec sources tailing CF
# Workers (`wrangler tail <name>`).
RUN npm install -g wrangler

# Fly CLI — used for `fly logs` style sources, and as a fallback for
# any flyctl-only operations.
RUN curl -L https://fly.io/install.sh | sh
ENV FLYCTL_INSTALL=/root/.fly
ENV PATH="${FLYCTL_INSTALL}/bin:${PATH}"

# Google Cloud SDK — used for `gcloud logging read` sources.
RUN curl -fsSL https://sdk.cloud.google.com | bash -s -- --install-dir=/opt --disable-prompts \
    && ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
    && ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil

# AWS CLI v2 — used for CloudWatch Logs tailing and any IAM-bound
# calls. Architecture-aware install so the same Dockerfile builds on
# arm64 (Fly's default for shared-cpu) and amd64.
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64)  AWSCLI_ARCH=x86_64 ;; \
         arm64)  AWSCLI_ARCH=aarch64 ;; \
         *) echo "unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWSCLI_ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

# At this point: vector + node + wrangler + flyctl + gcloud +
# awscli + python3. Image is large (~600 MB) but everything common
# is one apt/npm/curl away. The per-customer vector.yaml is mounted
# at /etc/vector/vector.yaml at machine create time (the deploy
# target's file-mount mechanism handles this).

# Vector API for `vector top` debugging.
EXPOSE 8686
# Heartbeat (Prometheus) exporter.
EXPOSE 9598

CMD ["vector", "--config", "/etc/vector/vector.yaml"]
