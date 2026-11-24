"""One-time asset preparation. Keep the original supplied logo unchanged."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
brand = root / 'public' / 'brand'
with Image.open(brand / 'logo.jpg') as image:
    logo = image.convert('RGB')
    logo.thumbnail((768, 512), Image.Resampling.LANCZOS)
    logo.save(brand / 'logo.webp', 'WEBP', quality=86, method=6)
with Image.open(root / 'tmp' / 'academia-original.jpg') as image:
    for width in (960, 1600):
        target = image.convert('RGB')
        target.thumbnail((width, width), Image.Resampling.LANCZOS)
        target.save(brand / f'academia-{width}.webp', 'WEBP', quality=79, method=6)
for filename in brand.glob('*.webp'):
    with Image.open(filename) as image:
        print(filename.name, image.size, filename.stat().st_size)
