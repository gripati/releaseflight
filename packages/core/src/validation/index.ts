export {
  IOS_SCREENSHOT_SPECS,
  IOS_PREVIEW_SPECS,
  MAX_PREVIEW_BYTES,
  validateIosScreenshot,
  validateIosPreview,
  screenshotToPreviewType,
  type IosScreenshotSpec,
  type IosPreviewSpec,
  type ScreenshotValidation,
} from "./screenshotSpecs";
export {
  ANDROID_IMAGE_SPECS,
  validateAndroidImage,
  type AndroidImageSpec,
  type AndroidImageKind,
} from "./androidImageSpecs";
export {
  detectVideoMagicBytes,
  videoMimeType,
  type VideoMagicByteResult,
} from "./videoMagicBytes";
