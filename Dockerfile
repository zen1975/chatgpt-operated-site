# Reproduces the supported clean-environment install for third parties who do
# not want to match the pinned Node/npm versions on their host.
#
#   docker build -t sitewright .
#   docker run --rm sitewright
#
# `.dockerignore` keeps local dependencies and secret material out of the build
# context, and excludes `.git`. The image therefore carries neither git metadata
# nor a git binary, so the contract checks resolve their file manifest from the
# filesystem here, verifying the distribution as shipped rather than a checkout.
# `scripts/distribution-files.mjs` fails loudly when that manifest comes back
# incomplete, so the checks cannot pass by inspecting nothing.
FROM node:22.23.2-bookworm-slim
WORKDIR /workspace

# package-lock.json is the install contract. Copy it with the manifest so the
# dependency layer is cached and `npm ci` cannot silently resolve new versions.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# In this image `localhost` resolves to ::1 before 127.0.0.1, so the Astro
# Cloudflare adapter's prerender server binds IPv6-only while the adapter then
# fetches it over IPv4 and gets ECONNREFUSED. Pinning the resolution order makes
# both ends agree. Without this the build fails inside the container only.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

CMD ["npm", "run", "verify"]
