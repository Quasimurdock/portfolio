#!/usr/bin/env deno
/**
 * Container health probe — exits 0 when the API answers, 1 otherwise.
 *
 * A file rather than an inline `deno eval` in the Dockerfile: the probe needs
 * the network and `PORT` from the environment, and keeping it here means it can
 * be run and verified outside a container build.
 *
 *   deno run --allow-net --allow-env scripts/healthcheck.mjs
 */
const port = Deno.env.get('PORT') ?? '8787'
const url = `http://127.0.0.1:${port}/api/health`

try {
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`healthcheck: ${url} → HTTP ${response.status}`)
    Deno.exit(1)
  }
  Deno.exit(0)
} catch (error) {
  console.error(`healthcheck: ${url} → ${error.message}`)
  Deno.exit(1)
}
