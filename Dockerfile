FROM node:22.23.2-bookworm-slim
WORKDIR /workspace
COPY package.json .npmrc ./
# package-lock.json is intentionally copied only after the first lock generation step.
# Production/CI builds MUST use npm ci once package-lock.json exists.
COPY . .
CMD ["bash"]
