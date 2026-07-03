import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // sharp (palette ΔE measurement) ships platform-specific native binaries and
  // dynamic requires that webpack can't bundle — keep it a server-side runtime
  // require. Without this, dev SSR 500s on every page via instrumentation.ts →
  // jobs → hugo → visual-qa → palette → sharp.
  serverExternalPackages: ["sharp", "playwright", "playwright-core"],
  // The edge-runtime compile of instrumentation.ts statically follows the
  // ticker's dynamic import (jobs → hugo → visual-qa → sharp + playwright-core)
  // even though register() bails on non-node runtimes, and native modules hard-
  // fail that compile (fsevents is darwin-only, so prod on the Linux box never
  // saw it). Stub the native packages in the edge bundle only; the node-runtime
  // bundle keeps the real ones via serverExternalPackages above.
  webpack: (config, { nextRuntime, webpack }) => {
    if (nextRuntime === "edge") {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        sharp: false,
        playwright: false,
        "playwright-core": false,
        fsevents: false,
      };
      // lanes.ts uses node: builtins (child_process, path); strip the scheme and
      // stub them so the never-executed edge bundle of instrumentation compiles.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        child_process: false,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        util: false,
        url: false,
      };
    }
    return config;
  },
};

export default nextConfig;
