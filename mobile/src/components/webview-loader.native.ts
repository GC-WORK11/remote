import type { ComponentType } from "react";
import { WebView } from "react-native-webview";

export const NativeWebView = WebView as unknown as ComponentType<Record<string, unknown>>;
