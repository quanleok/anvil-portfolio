import { NextResponse, type NextRequest } from "next/server";
import { bunnyDownloadUrlForObjectKey } from "@/lib/storage/bunny";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ file: string }>;
};

const DOWNLOADS: Record<string, { objectKey: string; contentType: string }> = {
  "forge-macos-arm64.dmg": {
    objectKey: process.env.ANVIL_MACOS_ARM64_DMG_OBJECT_KEY || "downloads/forge-macos-arm64-0.2.2-202605071158.dmg",
    contentType: "application/x-apple-diskimage",
  },
  "forge-macos-arm64.json": {
    objectKey: "downloads/forge-macos-arm64.json",
    contentType: "application/json",
  },
  "forge-windows-x64.exe": {
    objectKey: "downloads/forge-windows-x64.exe",
    contentType: "application/vnd.microsoft.portable-executable",
  },
  "forge-windows-x64.zip": {
    objectKey: "downloads/forge-windows-x64.zip",
    contentType: "application/zip",
  },
  "forge-windows-x64.json": {
    objectKey: "downloads/forge-windows-x64.json",
    contentType: "application/json",
  },
};

function jsonError(error: string, message: string, status: number) {
  return NextResponse.json({ error, message }, { status });
}

async function redirectDownload(_request: NextRequest, context: RouteContext) {
  const { file } = await context.params;
  const target = DOWNLOADS[file];
  if (!target) {
    return jsonError("download_not_found", "This Anvil download is not available.", 404);
  }

  const download = bunnyDownloadUrlForObjectKey(target.objectKey, { expiresInSeconds: 10 * 60 });
  if (!download) {
    return jsonError("download_not_configured", "Anvil downloads are not configured.", 503);
  }

  const response = NextResponse.redirect(download.url, 302);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-anvil-download", file);
  response.headers.set("x-anvil-download-content-type", target.contentType);
  return response;
}

export async function GET(request: NextRequest, context: RouteContext) {
  return redirectDownload(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  return redirectDownload(request, context);
}
