/**
 * Client-only: resizes and re-encodes profile images so the uploaded file stays at or under 5 MiB.
 * Import only from client components.
 */

export const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode image"));
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Draw `img` into a square-bounded box (max edge = maxSide), centered.
 */
function drawCover(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  maxSide: number,
): void {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw < 1 || ih < 1) throw new Error("Invalid image dimensions");

  const scale = Math.min(maxSide / iw, maxSide / ih, 1);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, w, h);
}

/**
 * Produces a JPEG Blob at most {@link MAX_PROFILE_PHOTO_BYTES} by lowering quality and then max edge.
 */
export async function compressProfilePhotoForUpload(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file (JPEG, PNG, WebP, or GIF).");
  }

  if (file.size <= MAX_PROFILE_PHOTO_BYTES && file.type === "image/jpeg") {
    return file;
  }

  const img = await loadImageFromFile(file);
  const canvas = document.createElement("canvas");
  let maxSide = 2048;
  let quality = 0.9;

  for (let attempt = 0; attempt < 24; attempt++) {
    drawCover(canvas, img, maxSide);
    const blob = await canvasToJpegBlob(canvas, quality);
    if (blob.size <= MAX_PROFILE_PHOTO_BYTES) {
      return blob;
    }
    if (quality > 0.55) {
      quality -= 0.06;
    } else {
      maxSide = Math.max(256, Math.floor(maxSide * 0.82));
      quality = 0.88;
    }
  }

  throw new Error(
    "Could not reduce the image under 5 MB. Try a smaller original or a different format.",
  );
}
