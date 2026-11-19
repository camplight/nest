// Clipboard screenshots arrive as `image.png`; they are kept as `pasted-<time>-<id>.<ext>` so several do not collide.
export function pastedImageFile(image: File): File {
  const ext = image.type.includes('/') ? image.type.split('/')[1] : 'png';
  const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'png';
  const filename = `pasted-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${safeExt}`;
  return new File([image], filename, {type: image.type || 'image/png'});
}
