"""Draw the Ajo app icons: a circle of member seats (some paid, marigold) around a pot.
Run from app/: python3 scripts/make-icons.py"""
import math
from PIL import Image, ImageDraw

INDIGO = (26, 39, 99, 255)
MARIGOLD = (244, 171, 31, 255)
CREAM = (247, 241, 227, 255)
RING = (247, 241, 227, 90)


def dial(size, fg_scale, bg=None, mono=False):
    s = size * 4  # supersample
    img = Image.new('RGBA', (s, s), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = s / 2
    r = s * 0.30 * fg_scale
    seat = s * 0.068 * fg_scale
    ring_w = max(2, int(s * 0.012 * fg_scale))
    d.ellipse([c - r, c - r, c + r, c + r], outline=(255, 255, 255, 255) if mono else RING, width=ring_w)
    n, paid = 6, 4
    for i in range(n):
        a = i / n * 2 * math.pi - math.pi / 2
        x, y = c + r * math.cos(a), c + r * math.sin(a)
        if mono:
            fill, outline = ((255, 255, 255, 255), None) if i < paid else (None, (255, 255, 255, 255))
        else:
            fill, outline = (MARIGOLD, None) if i < paid else (INDIGO, CREAM)
        d.ellipse([x - seat, y - seat, x + seat, y + seat], fill=fill, outline=outline, width=int(seat * 0.28))
    pot = s * 0.10 * fg_scale
    d.ellipse([c - pot, c - pot, c + pot, c + pot], fill=(255, 255, 255, 255) if mono else MARIGOLD)
    return img.resize((size, size), Image.LANCZOS)


dial(1024, 0.95, INDIGO).convert('RGB').save('assets/icon.png')
dial(512, 0.8).save('assets/android-icon-foreground.png')  # adaptive: keep inside the safe zone
Image.new('RGBA', (512, 512), INDIGO).save('assets/android-icon-background.png')
dial(432, 0.8, mono=True).save('assets/android-icon-monochrome.png')
dial(1024, 1.0).save('assets/splash-icon.png')
dial(48, 1.0, INDIGO).save('assets/favicon.png')
print('icons written')
