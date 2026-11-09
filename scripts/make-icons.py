"""Makes every app icon and logo image from build/logo.webp (the Personal PACS logo on black).

    pip install pillow numpy
    python scripts/make-icons.py

Writes:
  build/icon.png                          Windows/Linux program + installer icon (512 px)
  src/renderer/src/assets/logo-mark.png   "P" mark for the PC app's left rail
  src/mobile/public/logo.png              full logo for the phone app's screens
  android/app/src/main/res/...            launcher icons (legacy, round, adaptive) and splash screens
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = Image.open(ROOT / 'build/logo.webp').convert('RGB')
RES = ROOT / 'android/app/src/main/res'

# Regions of the source logo (1254 x 1254, black background).
MARK_BOX = (310, 230, 910, 830)  # the "P" with its ring; stops above the text
FULL_BOX = (150, 205, 1115, 970)  # mark + "Personal PACS"


def crop(box):
    return SRC.crop(box)


def black_to_alpha(img):
    """Glowing artwork on black -> the same artwork on transparent (looks identical over black)."""
    a = np.asarray(img.convert('RGB')).astype(np.float32)
    alpha = a.max(axis=2)
    rgb = np.where(alpha[..., None] > 0, a * 255.0 / np.maximum(alpha[..., None], 1), 0)
    out = np.dstack([np.clip(rgb, 0, 255), alpha]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def on_canvas(art, size, scale, shape):
    """Black rounded square / circle (or nothing) with the artwork centred at `scale` of the size."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    if shape == 'square':
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.2), fill=255)
    elif shape == 'circle':
        d.ellipse((0, 0, size - 1, size - 1), fill=255)
    if shape != 'none':
        canvas.paste(Image.new('RGBA', (size, size), (0, 0, 0, 255)), (0, 0), mask)
    side = round(size * scale)
    a = art.resize((side, side), Image.LANCZOS)
    canvas.alpha_composite(a, ((size - side) // 2, (size - side) // 2))
    if shape != 'none':
        canvas.putalpha(Image.fromarray(np.minimum(np.asarray(canvas.getchannel('A')), np.asarray(mask))))
    return canvas


mark = black_to_alpha(crop(MARK_BOX))
full = black_to_alpha(crop(FULL_BOX))

# Program icon (electron-builder makes the Windows .ico from it).
on_canvas(mark, 512, 0.9, 'square').save(ROOT / 'build/icon.png')
# PC app rail.
on_canvas(mark, 128, 1.0, 'none').save(ROOT / 'src/renderer/src/assets/logo-mark.png')
# Phone app screens.
(ROOT / 'src/mobile/public').mkdir(parents=True, exist_ok=True)
fw = 720
full.resize((fw, round(fw * full.height / full.width)), Image.LANCZOS).save(ROOT / 'src/mobile/public/logo.png')

# Android launcher icons.
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, k in DENS.items():
    folder = RES / f'mipmap-{d}'
    folder.mkdir(parents=True, exist_ok=True)
    on_canvas(mark, round(48 * k), 0.92, 'square').save(folder / 'ic_launcher.png')
    on_canvas(mark, round(48 * k), 0.84, 'circle').save(folder / 'ic_launcher_round.png')
    # Adaptive icon foreground: the mark inside the 66 dp safe zone of the 108 dp layer.
    on_canvas(mark, round(108 * k), 0.62, 'none').save(folder / 'ic_launcher_foreground.png')

# Splash screens (older Android): black with the full logo in the middle, same sizes as before.
for folder in RES.glob('drawable*'):
    f = folder / 'splash.png'
    if not f.exists():
        continue
    w, h = Image.open(f).size
    canvas = Image.new('RGB', (w, h), (0, 0, 0))
    lw = round(min(w, h) * 0.62)
    logo = full.resize((lw, round(lw * full.height / full.width)), Image.LANCZOS)
    canvas.paste(logo, ((w - logo.width) // 2, (h - logo.height) // 2), logo)
    canvas.save(f)

print('icons written')
