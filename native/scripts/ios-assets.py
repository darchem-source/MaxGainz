#!/usr/bin/env python3
"""Regenerate the iOS app icon and launch-screen images from icon.png.

    python3 native/scripts/ios-assets.py        (needs Pillow: python3 -m pip install pillow)

Run it only when icon.png or the --bg colour in index.html changes, then
commit the PNGs it writes. It is not part of the build.

- App icon: App Store icons must be opaque (an alpha channel fails upload
  with ITMS-90717). icon.png has transparent rounded corners, so it is
  flattened onto the app background colour (--bg in index.html's :root)
  and saved as a 1024x1024 RGB PNG. iOS applies its own corner mask, which
  is almost exactly icon.png's own corner radius.
- Launch screen: the icon centred on --bg, 2732x2732, shown with "aspect
  fill" by LaunchScreen.storyboard, so it is about 120 pt wide on current
  iPhones, the size of the logo on the page's own splash.
"""
import os
import re
import sys

from PIL import Image

NATIVE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # native/
ROOT = os.path.dirname(NATIVE)                                        # repo root
ASSETS = os.path.join(NATIVE, 'ios', 'App', 'App', 'Assets.xcassets')
SPLASH_SIZE = 2732
SPLASH_ICON = 376  # px inside the 2732 px square


def app_background():
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        head = f.read(200_000)  # :root is near the top; skip the base64 blobs further down
    m = re.search(r'--bg:\s*#([0-9a-fA-F]{6})\b', head)
    if not m:
        sys.exit('could not find --bg in index.html')
    return tuple(int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))


def main():
    bg = app_background()
    icon = Image.open(os.path.join(ROOT, 'icon.png')).convert('RGBA')
    if icon.size != (1024, 1024):
        sys.exit('icon.png must be 1024x1024, got %dx%d' % icon.size)

    flat = Image.new('RGBA', icon.size, bg + (255,))
    flat.alpha_composite(icon)
    out = os.path.join(ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png')
    flat.convert('RGB').save(out, optimize=True)

    splash = Image.new('RGBA', (SPLASH_SIZE, SPLASH_SIZE), bg + (255,))
    small = icon.resize((SPLASH_ICON, SPLASH_ICON), Image.LANCZOS)
    off = (SPLASH_SIZE - SPLASH_ICON) // 2
    splash.alpha_composite(small, (off, off))
    splash = splash.convert('RGB')
    for name in ('splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'):
        splash.save(os.path.join(ASSETS, 'Splash.imageset', name), optimize=True)

    print('ios-assets: background #%02x%02x%02x; wrote AppIcon (1024, RGB) and 3 splash images' % bg)


if __name__ == '__main__':
    main()
