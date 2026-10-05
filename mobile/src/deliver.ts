// Pull a file off the rig into phone storage and open the share sheet.
// Shared by the thread's DeliverCard and the code file viewer's share
// action — one path, one truth about where deliveries land.
import { rig } from "./rig";

// Lazy native imports — a dev client built before these modules shipped
// would crash on eager import; resolved at call time instead.
const FileSystem: typeof import("expo-file-system/legacy") | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-file-system/legacy");
  } catch {
    return null;
  }
})();
const Sharing: typeof import("expo-sharing") | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-sharing");
  } catch {
    return null;
  }
})();

export async function pullFileToPhone(path: string, name?: string): Promise<string> {
  const fileName = name || path.split("/").pop() || "file";
  const r = await rig.fsCall("rig.fs.read", { path, maxBytes: 48 << 20 }, 90000);
  // A partial read saved to disk looks like a file but is corrupt — refuse
  // it honestly instead of letting the user share a truncated artifact.
  if (r?.truncated === true) {
    const mb = typeof r?.size === "number" ? Math.round(r.size / (1 << 20)) : 0;
    throw new Error(`file too large to pull${mb ? ` (${mb} MB)` : ""}`);
  }
  // Text files come back as `content`; binary as `contentBase64`.
  const b64 = r?.contentBase64;
  const text = typeof r?.content === "string" ? r.content : null;
  if ((typeof b64 !== "string" || !b64) && text === null) throw new Error("no data");
  if (!FileSystem?.documentDirectory) throw new Error("no filesystem");
  const dir = `${FileSystem.documentDirectory}remote-files/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const uri = dir + fileName;
  if (typeof b64 === "string" && b64)
    await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });
  else await FileSystem.writeAsStringAsync(uri, text ?? "");
  // The file landing on the phone is the success — the share sheet is a
  // bonus that can fail on dev clients missing the native module.
  try {
    if (Sharing && (await Sharing.isAvailableAsync()))
      await Sharing.shareAsync(uri, { dialogTitle: fileName });
  } catch {}
  return uri;
}
