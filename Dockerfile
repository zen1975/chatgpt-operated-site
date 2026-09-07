# Reproduces the supported clean-environment install for third parties who do
# not want to match the pinned Node/npm versions on their host.
#
#   docker build -t chatgpt-operated-site .
#   docker run --rm chatgpt-operated-site npm run verify
FROM node:22.23.2-bookworm-slim
WORKDIR /workspace

# package-lock.json is the install contract. Copy it with the manifest so the
# dependency layer is cached and `npm ci` cannot silently resolve new versions.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
CMD ["npm", "run", "verify"]
