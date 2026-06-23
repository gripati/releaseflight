/**
 * Apple App Store Connect screenshot + preview specs.
 *
 * Source: Apple "App preview and screenshot specifications" (2026 edition)
 * plus the Unity reference (Assets/Release Flight/Editor/Apps/ScreenshotManager.cs).
 *
 * Notes:
 *   • PRIMARY device types are required for App Store visibility on every
 *     submission. Other display types are optional (Apple scales from PRIMARY).
 *   • Each spec accepts multiple resolution pairs (portrait + landscape +
 *     legacy variants). We accept ANY valid pair.
 *   • App previews use the screenshot device id WITHOUT the "APP_" prefix
 *     (e.g. APP_IPHONE_65 → IPHONE_65). See screenshotToPreviewType().
 *   • Max file size: 8 MB for screenshots; 500 MB for previews.
 */

export interface IosScreenshotSpec {
  /** Apple displayType string, e.g. "APP_IPHONE_65" */
  id: string;
  displayName: string;
  /** Primary canonical pair, used for help text and default sort order */
  primaryWidth: number;
  primaryHeight: number;
  /** Every accepted (w,h) pair — portrait + landscape + legacy */
  validSizes: readonly (readonly [number, number])[];
  minRequired: number;
  /** Always 10 for App Store, but tracked explicitly for future-proofing */
  maxAllowed: number;
  /** Apple submission requires at least one image on PRIMARY device types */
  isPrimary: boolean;
  description: string;
}

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 500 * 1024 * 1024;

export const IOS_SCREENSHOT_SPECS: Record<string, IosScreenshotSpec> = {
  APP_IPHONE_67: {
    id: "APP_IPHONE_67",
    displayName: 'iPhone 6.7" Display',
    primaryWidth: 1290,
    primaryHeight: 2796,
    validSizes: [
      [1290, 2796],
      [2796, 1290],
      [1320, 2868],
      [2868, 1320],
    ],
    minRequired: 1,
    maxAllowed: 10,
    isPrimary: true,
    description: "iPhone 15 Pro Max, 16 Pro Max",
  },
  APP_IPHONE_65: {
    id: "APP_IPHONE_65",
    displayName: 'iPhone 6.5" Display',
    primaryWidth: 1284,
    primaryHeight: 2778,
    validSizes: [
      [1284, 2778],
      [2778, 1284],
      [1242, 2688],
      [2688, 1242],
    ],
    minRequired: 1,
    maxAllowed: 10,
    isPrimary: true,
    description: "iPhone Xs Max / 11 Pro Max / 12 / 13 / 14 Plus",
  },
  APP_IPHONE_61: {
    id: "APP_IPHONE_61",
    displayName: 'iPhone 6.1" Display',
    primaryWidth: 1170,
    primaryHeight: 2532,
    validSizes: [
      [1170, 2532],
      [2532, 1170],
      [1179, 2556],
      [2556, 1179],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: "iPhone 12 / 13 / 14 / 15",
  },
  APP_IPHONE_55: {
    id: "APP_IPHONE_55",
    displayName: 'iPhone 5.5" Display',
    primaryWidth: 1242,
    primaryHeight: 2208,
    validSizes: [
      [1242, 2208],
      [2208, 1242],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: "iPhone 6 Plus, 7 Plus, 8 Plus",
  },
  APP_IPHONE_47: {
    id: "APP_IPHONE_47",
    displayName: 'iPhone 4.7" Display',
    primaryWidth: 750,
    primaryHeight: 1334,
    validSizes: [
      [750, 1334],
      [1334, 750],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: "iPhone 6, 7, 8, SE 2nd/3rd Gen",
  },
  APP_IPHONE_40: {
    id: "APP_IPHONE_40",
    displayName: 'iPhone 4" Display',
    primaryWidth: 640,
    primaryHeight: 1096,
    validSizes: [
      [640, 1096],
      [1096, 640],
      [640, 1136],
      [1136, 640],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: "iPhone 5, 5s, 5c, SE 1st Gen",
  },
  APP_IPHONE_35: {
    id: "APP_IPHONE_35",
    displayName: 'iPhone 3.5" Display',
    primaryWidth: 640,
    primaryHeight: 920,
    validSizes: [
      [640, 920],
      [920, 640],
      [640, 960],
      [960, 640],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: "iPhone 4s",
  },
  APP_IPAD_PRO_3GEN_129: {
    id: "APP_IPAD_PRO_3GEN_129",
    displayName: 'iPad Pro 12.9" (3rd Gen+)',
    primaryWidth: 2048,
    primaryHeight: 2732,
    validSizes: [
      [2048, 2732],
      [2732, 2048],
    ],
    minRequired: 1,
    maxAllowed: 10,
    isPrimary: true,
    description: 'iPad Pro 12.9" frameless (3rd Gen+)',
  },
  APP_IPAD_PRO_3GEN_11: {
    id: "APP_IPAD_PRO_3GEN_11",
    displayName: 'iPad Pro 11" (3rd Gen+)',
    primaryWidth: 1668,
    primaryHeight: 2388,
    validSizes: [
      [1668, 2388],
      [2388, 1668],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: 'iPad Pro 11" frameless',
  },
  APP_IPAD_PRO_129: {
    id: "APP_IPAD_PRO_129",
    displayName: 'iPad Pro 12.9" (2nd Gen)',
    primaryWidth: 2048,
    primaryHeight: 2732,
    validSizes: [
      [2048, 2732],
      [2732, 2048],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: 'iPad Pro 12.9" with home button',
  },
  APP_IPAD_105: {
    id: "APP_IPAD_105",
    displayName: 'iPad 10.5"',
    primaryWidth: 1668,
    primaryHeight: 2224,
    validSizes: [
      [1668, 2224],
      [2224, 1668],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: 'iPad Pro 10.5", iPad Air 3rd Gen',
  },
  APP_IPAD_97: {
    id: "APP_IPAD_97",
    displayName: 'iPad 9.7"',
    primaryWidth: 1536,
    primaryHeight: 2048,
    validSizes: [
      [1536, 2048],
      [2048, 1536],
    ],
    minRequired: 0,
    maxAllowed: 10,
    isPrimary: false,
    description: 'iPad 9.7", iPad Air 1st/2nd Gen, iPad Mini 4',
  },
};

// ───────────────────────────────────────────────────────────────────────
// App preview specs (videos)
// ───────────────────────────────────────────────────────────────────────

export interface IosPreviewSpec {
  /** Preview type — display type WITHOUT "APP_" prefix */
  id: string;
  displayName: string;
  primaryWidth: number;
  primaryHeight: number;
  validSizes: readonly (readonly [number, number])[];
  maxAllowed: number;
  description: string;
}

export const IOS_PREVIEW_SPECS: Record<string, IosPreviewSpec> = {
  IPHONE_67: {
    id: "IPHONE_67",
    displayName: 'iPhone 6.7"',
    primaryWidth: 886,
    primaryHeight: 1920,
    validSizes: [
      [886, 1920],
      [1920, 886],
      [1080, 1920],
      [1920, 1080],
    ],
    maxAllowed: 3,
    description: "Plus / Pro Max",
  },
  IPHONE_65: {
    id: "IPHONE_65",
    displayName: 'iPhone 6.5"',
    primaryWidth: 886,
    primaryHeight: 1920,
    validSizes: [
      [886, 1920],
      [1920, 886],
      [1080, 1920],
      [1920, 1080],
    ],
    maxAllowed: 3,
    description: "Xs Max / 11 Pro Max",
  },
  IPHONE_61: {
    id: "IPHONE_61",
    displayName: 'iPhone 6.1"',
    primaryWidth: 886,
    primaryHeight: 1920,
    validSizes: [
      [886, 1920],
      [1920, 886],
    ],
    maxAllowed: 3,
    description: "iPhone 12 / 13 / 14 / 15",
  },
  IPHONE_55: {
    id: "IPHONE_55",
    displayName: 'iPhone 5.5"',
    primaryWidth: 1080,
    primaryHeight: 1920,
    validSizes: [
      [1080, 1920],
      [1920, 1080],
    ],
    maxAllowed: 3,
    description: "iPhone 8 Plus",
  },
  IPHONE_47: {
    id: "IPHONE_47",
    displayName: 'iPhone 4.7"',
    primaryWidth: 750,
    primaryHeight: 1334,
    validSizes: [
      [750, 1334],
      [1334, 750],
    ],
    maxAllowed: 3,
    description: "iPhone 8",
  },
  IPHONE_40: {
    id: "IPHONE_40",
    displayName: 'iPhone 4"',
    primaryWidth: 640,
    primaryHeight: 1136,
    validSizes: [
      [640, 1136],
      [1136, 640],
    ],
    maxAllowed: 3,
    description: "iPhone SE 1st Gen",
  },
  IPAD_PRO_3GEN_129: {
    id: "IPAD_PRO_3GEN_129",
    displayName: 'iPad Pro 12.9" (3rd Gen+)',
    primaryWidth: 1200,
    primaryHeight: 1600,
    validSizes: [
      [1200, 1600],
      [1600, 1200],
    ],
    maxAllowed: 3,
    description: "Frameless iPad Pro",
  },
  IPAD_PRO_3GEN_11: {
    id: "IPAD_PRO_3GEN_11",
    displayName: 'iPad Pro 11" (3rd Gen+)',
    primaryWidth: 1200,
    primaryHeight: 1600,
    validSizes: [
      [1200, 1600],
      [1600, 1200],
    ],
    maxAllowed: 3,
    description: 'Frameless iPad Pro 11"',
  },
  IPAD_PRO_129: {
    id: "IPAD_PRO_129",
    displayName: 'iPad Pro 12.9" (2nd Gen)',
    primaryWidth: 1200,
    primaryHeight: 1600,
    validSizes: [
      [1200, 1600],
      [1600, 1200],
    ],
    maxAllowed: 3,
    description: 'iPad Pro 12.9" with home button',
  },
  IPAD_105: {
    id: "IPAD_105",
    displayName: 'iPad 10.5"',
    primaryWidth: 1200,
    primaryHeight: 1600,
    validSizes: [
      [1200, 1600],
      [1600, 1200],
    ],
    maxAllowed: 3,
    description: 'iPad Pro 10.5" / iPad Air 3',
  },
  IPAD_97: {
    id: "IPAD_97",
    displayName: 'iPad 9.7"',
    primaryWidth: 900,
    primaryHeight: 1200,
    validSizes: [
      [900, 1200],
      [1200, 900],
    ],
    maxAllowed: 3,
    description: "Standard iPad / Air 2",
  },
};

export function screenshotToPreviewType(displayType: string): string {
  return displayType.replace(/^APP_/, "");
}

// ───────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────

export interface ScreenshotValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  spec: IosScreenshotSpec | null;
}

export function validateIosScreenshot(input: {
  displayType: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  mimeType?: string;
}): ScreenshotValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.fileSizeBytes > MAX_SCREENSHOT_BYTES) {
    errors.push(`File too large: ${(input.fileSizeBytes / 1024 / 1024).toFixed(2)} MB (max 8 MB)`);
  }

  if (input.mimeType && !["image/png", "image/jpeg"].includes(input.mimeType)) {
    errors.push(`Unsupported MIME type: ${input.mimeType} (PNG or JPEG required)`);
  }

  const spec = IOS_SCREENSHOT_SPECS[input.displayType] ?? null;
  if (!spec) {
    warnings.push(
      `Unknown displayType "${input.displayType}" — App Store will validate server-side`,
    );
    return { ok: errors.length === 0, errors, warnings, spec: null };
  }

  const matches = spec.validSizes.some(([w, h]) => w === input.width && h === input.height);
  if (!matches) {
    errors.push(
      `Invalid dimensions ${input.width}×${input.height} for ${spec.displayName}. ` +
        `Accepted: ${spec.validSizes.map(([w, h]) => `${w.toString()}×${h.toString()}`).join(", ")}`,
    );
  }

  return { ok: errors.length === 0, errors, warnings, spec };
}

export function validateIosPreview(input: {
  previewType: string;
  width?: number;
  height?: number;
  fileSizeBytes: number;
  mimeType?: string;
}): ScreenshotValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.fileSizeBytes > MAX_PREVIEW_BYTES) {
    errors.push(
      `File too large: ${(input.fileSizeBytes / 1024 / 1024).toFixed(2)} MB (max 500 MB)`,
    );
  }

  const allowed = ["video/mp4", "video/quicktime", "video/x-m4v"];
  if (input.mimeType && !allowed.includes(input.mimeType)) {
    errors.push(`Unsupported MIME type: ${input.mimeType} (mp4, quicktime, x-m4v required)`);
  }

  const spec = IOS_PREVIEW_SPECS[input.previewType] ?? null;
  if (!spec) {
    warnings.push(
      `Unknown previewType "${input.previewType}" — Apple validates codec/duration server-side`,
    );
    return { ok: errors.length === 0, errors, warnings, spec: null };
  }

  if (input.width && input.height) {
    const matches = spec.validSizes.some(([w, h]) => w === input.width && h === input.height);
    if (!matches) {
      warnings.push(
        `Dimensions ${input.width}×${input.height} not in standard list for ${spec.displayName}. ` +
          `Apple may accept; preferred sizes: ${spec.validSizes.map(([w, h]) => `${w.toString()}×${h.toString()}`).join(", ")}`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, spec: spec as unknown as IosScreenshotSpec };
}
