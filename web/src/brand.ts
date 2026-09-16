/**
 * The product name.
 *
 * One constant behind the browser title, the public chrome and the back office,
 * with a build-time escape hatch (`VITE_SITE_NAME`) so the app can be reskinned
 * without touching code. The server keeps its own copy (`config.siteName`),
 * which is what the RSS feed announces.
 */
const configured = (import.meta.env.VITE_SITE_NAME as string | undefined)?.trim()

export const SITE_NAME = configured || 'Ob5erver'
