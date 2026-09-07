import { z } from 'zod';
import { CommandError } from '../../core/errors';
import { AssetProvider, type AssetBinary, type AssetIntake } from '../../core/assets';

export const ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_MAX_DIMENSION = 12000;

export const AssetMime = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']);
export type AssetMimeType = z.infer<typeof AssetMime>;

export type FetchedAssetMetadata = {
  mimeType: AssetMimeType;
  originalFilename: string;
  width?: number | null;
  height?: number | null;
  sourceMetadata?: Record<string, string | number | boolean | null>;
};

export type AssetFetchResult = {
  bytes: AssetBinary;
  metadata: FetchedAssetMetadata;
};

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new CommandError('USER_CORRECTABLE', code, message, false, details);
}

export async function sha256Hex(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readU32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function imageDimensions(bytes: Uint8Array, mimeType: AssetMimeType): { width: number; height: number } | null {
  if (mimeType === 'image/png' && bytes.length >= 24) return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
  if (mimeType === 'image/webp' && bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === 'WEBP' && String.fromCharCode(...bytes.slice(16, 20)) === 'VP8X') {
      return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    }
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: (bytes[offset + 5] << 8) + bytes[offset + 6], width: (bytes[offset + 7] << 8) + bytes[offset + 8] };
      }
      offset += length + 2;
    }
  }
  return null;
}

function matchesMagic(bytes: Uint8Array, mimeType: AssetMimeType) {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mimeType === 'image/png') return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mimeType === 'image/jpeg') return starts([255, 216, 255]);
  if (mimeType === 'application/pdf') return starts([37, 80, 68, 70, 45]);
  if (mimeType === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mimeType === 'image/avif') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' && ['avif', 'avis'].some((brand) => String.fromCharCode(...bytes.slice(8, 12)) === brand);
  return false;
}

export async function validateFetchedAsset(reference: { expectedMimeType?: AssetMimeType; expectedSha256?: string }, fetched: AssetFetchResult) {
  const { bytes, metadata } = fetched;
  if (!(bytes instanceof Uint8Array)) fail('ASSET_TRANSFER_INVALID', 'Asset transfer must be a Uint8Array.');
  if (bytes.byteLength < 1 || bytes.byteLength > ASSET_MAX_BYTES) fail('ASSET_SIZE_INVALID', 'Asset size is outside the allowed range.', { maxBytes: ASSET_MAX_BYTES });
  if (reference.expectedMimeType && reference.expectedMimeType !== metadata.mimeType) fail('ASSET_MIME_MISMATCH', 'Asset MIME type does not match the requested reference.');
  if (!matchesMagic(bytes, metadata.mimeType)) fail('ASSET_MAGIC_MISMATCH', 'Asset binary signature does not match its MIME type.');
  const dimensions = imageDimensions(bytes, metadata.mimeType);
  const width = dimensions?.width ?? metadata.width ?? null;
  const height = dimensions?.height ?? metadata.height ?? null;
  if (metadata.width != null && dimensions && metadata.width !== dimensions.width) fail('ASSET_DIMENSIONS_MISMATCH', 'Asset width does not match provider metadata.');
  if (metadata.height != null && dimensions && metadata.height !== dimensions.height) fail('ASSET_DIMENSIONS_MISMATCH', 'Asset height does not match provider metadata.');
  if (metadata.mimeType.startsWith('image/') && (!width || !height || width > ASSET_MAX_DIMENSION || height > ASSET_MAX_DIMENSION)) fail('ASSET_DIMENSIONS_INVALID', 'Image dimensions are missing or outside the allowed range.');
  const sha256 = await sha256Hex(bytes);
  if (reference.expectedSha256 && reference.expectedSha256 !== sha256) fail('ASSET_SHA256_MISMATCH', 'Asset SHA-256 does not match the requested reference.');
  const sourceProvider = AssetProvider.parse(
    metadata.sourceMetadata?.provider ?? 'generated'
  );

  const descriptor: AssetIntake = {
    sourceProvider,
    sourceId: String(metadata.sourceMetadata?.sourceId ?? ''),
    originalFilename: metadata.originalFilename,
    mimeType: metadata.mimeType,
    bytes: bytes.byteLength,
    width,
    height,
    expectedSha256: sha256,
    sourceMetadata: metadata.sourceMetadata ?? {},
    alt: '',
    caption: null,
    description: null,
    variant: 'original',
    associations: []
  };
  return { descriptor, bytes, sha256 };
}

export function responseBytes(response: Response) {
  return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}
