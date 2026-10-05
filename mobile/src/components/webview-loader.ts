import type { ComponentType } from "react";

// Metro resolves webview-loader.native.ts on iOS/Android; this file serves
// web bundles (and tsc, which has no platform resolution) — value is null so
// the sheet falls back to its iframe branch on web.
export const NativeWebView = null as unknown as ComponentType<Record<string, unknown>>;
