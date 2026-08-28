# Builds and runs the whole app from the repo root as its build context
# (see docker-compose.yml's `app` service) — the workspace needs
# packages/web and packages/shared alongside packages/server to install
# and build. Runs the server the same way dev does, via tsx: nothing in
# this repo compiles TypeScript to JS ahead of time (packages/server's
# tsconfig sets noEmit, and @itg/shared's package.json exports its raw
# .ts source), so introducing a tsc build step here would diverge from
# how the app actually runs rather than simplify anything.
FROM node:22-slim

WORKDIR /app

# Prisma's query engine needs libssl, which node:22-slim doesn't ship.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .

# main.ts hard-codes a repo-root `.env` path (see its `loadEnvFile` call)
# because that's how dev runs too. Node only fills in vars *missing* from
# the process environment when loading an env file, so an empty file here
# just satisfies that read — real values come from docker-compose's
# `environment`/`env_file` below, same as any other container config.
RUN touch .env

RUN npm run db:generate
RUN npm run build --workspace packages/web

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "bot", "--workspace", "packages/server"]
