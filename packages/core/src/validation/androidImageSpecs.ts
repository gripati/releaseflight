/**
 * Google Play Console image specifications. Distinct concepts from iOS:
 *   • PhoneScreenshots / sevenInch / tenInch — multi-image carousels per language
 *   • Icon — single high-res 512×512
 *   • Feature graphic — single 1024×500
 *   • TV banner — single 1280×720
 *   • Promo graphic — deprecated but supported
 *
 * Google requires exact dimensions on single-asset types; carousels accept
 * any size within min/max range.
 */

export type AndroidImageKind =
  | "phoneScreenshots"
  | "sevenInchScreenshots"
  | "tenInchScreenshots"
  | "tvScreenshots"
  | "wearScreenshots"
  | "icon"
  | "featureGraphic"
  | "tvBanner"
  | "promoGraphic";

export interface AndroidImageSpec {
  id: AndroidImageKind;
  displayName: string;
  /** True = single image slot; false = carousel (max N) */
  isSingle: boolean;
  /** Exact size if specified; otherwise min/max range */
  exactWidth?: number;
  exactHeight?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  minRequired: number;
  maxAllowed: number;
  /** Required for store listing visibility */
  isRequired: boolean;
  description: string;
}

export const MAX_ANDROID_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ANDROID_FEATURE_BYTES = 1 * 1024 * 1024;

export const ANDROID_IMAGE_SPECS: Record<AndroidImageKind, AndroidImageSpec> = {
  phoneScreenshots: {
    id: "phoneScreenshots",
    displayName: "Phone screenshots",
    isSingle: false,
    minWidth: 320, minHeight: 320,
    maxWidth: 3840, maxHeight: 3840,
    minRequired: 2,
    maxAllowed: 8,
    isRequired: true,
    description: "16:9 or 9:16 recommended · PNG/JPEG · up to 8 MB",
  },
  sevenInchScreenshots: {
    id: "sevenInchScreenshots",
    displayName: "7\" Tablet screenshots",
    isSingle: false,
    minWidth: 320, minHeight: 320,
    maxWidth: 3840, maxHeight: 3840,
    minRequired: 0, maxAllowed: 8,
    isRequired: false,
    description: "Optional · 7-inch tablet preview",
  },
  tenInchScreenshots: {
    id: "tenInchScreenshots",
    displayName: "10\" Tablet screenshots",
    isSingle: false,
    minWidth: 320, minHeight: 320,
    maxWidth: 3840, maxHeight: 3840,
    minRequired: 0, maxAllowed: 8,
    isRequired: false,
    description: "Optional · 10-inch tablet preview",
  },
  tvScreenshots: {
    id: "tvScreenshots",
    displayName: "Android TV screenshots",
    isSingle: false,
    minWidth: 1280, minHeight: 720,
    maxWidth: 1920, maxHeight: 1920,
    minRequired: 0, maxAllowed: 8,
    isRequired: false,
    description: "16:9 landscape · Android TV",
  },
  wearScreenshots: {
    id: "wearScreenshots",
    displayName: "Wear OS screenshots",
    isSingle: false,
    exactWidth: 384, exactHeight: 384,
    minRequired: 0, maxAllowed: 8,
    isRequired: false,
    description: "Square 384×384 · Wear OS only",
  },
  icon: {
    id: "icon",
    displayName: "App icon",
    isSingle: true,
    exactWidth: 512, exactHeight: 512,
    minRequired: 1, maxAllowed: 1,
    isRequired: true,
    description: "Hi-res icon · exactly 512×512 PNG (32-bit) · up to 1 MB",
  },
  featureGraphic: {
    id: "featureGraphic",
    displayName: "Feature graphic",
    isSingle: true,
    exactWidth: 1024, exactHeight: 500,
    minRequired: 0, maxAllowed: 1,
    isRequired: false,
    description: "Hero banner · exactly 1024×500 PNG/JPEG · up to 1 MB",
  },
  tvBanner: {
    id: "tvBanner",
    displayName: "TV banner",
    isSingle: true,
    exactWidth: 1280, exactHeight: 720,
    minRequired: 0, maxAllowed: 1,
    isRequired: false,
    description: "Android TV banner · 1280×720",
  },
  promoGraphic: {
    id: "promoGraphic",
    displayName: "Promo graphic",
    isSingle: true,
    exactWidth: 180, exactHeight: 120,
    minRequired: 0, maxAllowed: 1,
    isRequired: false,
    description: "Legacy 180×120 promo",
  },
};

export function validateAndroidImage(input: {
  imageKind: AndroidImageKind;
  width: number;
  height: number;
  fileSizeBytes: number;
  mimeType?: string;
}): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  spec: AndroidImageSpec;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const spec = ANDROID_IMAGE_SPECS[input.imageKind];

  if (!spec) {
    errors.push(`Unknown image kind: ${input.imageKind as string}`);
    return { ok: false, errors, warnings, spec: spec as unknown as AndroidImageSpec };
  }

  const sizeCap =
    spec.id === "icon" || spec.id === "featureGraphic" || spec.id === "promoGraphic"
      ? MAX_ANDROID_FEATURE_BYTES
      : MAX_ANDROID_IMAGE_BYTES;

  if (input.fileSizeBytes > sizeCap) {
    errors.push(
      `File too large: ${(input.fileSizeBytes / 1024 / 1024).toFixed(2)} MB (max ${(sizeCap / 1024 / 1024).toString()} MB)`,
    );
  }

  if (input.mimeType && !["image/png", "image/jpeg"].includes(input.mimeType)) {
    errors.push(`Unsupported MIME type: ${input.mimeType} (PNG or JPEG required)`);
  }

  if (spec.exactWidth !== undefined && spec.exactHeight !== undefined) {
    if (input.width !== spec.exactWidth || input.height !== spec.exactHeight) {
      errors.push(
        `Dimensions ${input.width.toString()}×${input.height.toString()} must be ` +
          `exactly ${spec.exactWidth.toString()}×${spec.exactHeight.toString()} for ${spec.displayName}`,
      );
    }
  } else {
    if (spec.minWidth !== undefined && input.width < spec.minWidth) {
      errors.push(`Width ${input.width.toString()} below min ${spec.minWidth.toString()}`);
    }
    if (spec.maxWidth !== undefined && input.width > spec.maxWidth) {
      errors.push(`Width ${input.width.toString()} exceeds max ${spec.maxWidth.toString()}`);
    }
    if (spec.minHeight !== undefined && input.height < spec.minHeight) {
      errors.push(`Height ${input.height.toString()} below min ${spec.minHeight.toString()}`);
    }
    if (spec.maxHeight !== undefined && input.height > spec.maxHeight) {
      errors.push(`Height ${input.height.toString()} exceeds max ${spec.maxHeight.toString()}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, spec };
}
