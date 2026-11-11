/**
 * Non-code assets embedded as text at build time, so the same imports work in
 * Node (tsup `loader`) and in the Cloudflare Worker (wrangler `rules`), neither
 * of which can read them from a filesystem at runtime.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
declare module '*.yaml' {
  const text: string;
  export default text;
}
declare module '*.svg' {
  const text: string;
  export default text;
}
declare module '*.html' {
  const text: string;
  export default text;
}
/** Binary assets (wrangler `Data` rule): the bytes, as an ArrayBuffer. */
declare module '*.woff2' {
  const data: ArrayBuffer;
  export default data;
}
