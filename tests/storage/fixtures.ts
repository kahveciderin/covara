const u8 = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

const pad = (data: Uint8Array, length: number): Uint8Array => {
  const out = new Uint8Array(Math.max(length, data.length));
  out.set(data);
  return out;
};

export const fixtures = {
  png: pad(u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR"), 64),
  jpeg: pad(u8([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF"), 64),
  gif: u8("GIF89a", [1, 0, 1, 0, 0x80, 0, 0]),
  webp: pad(u8("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "), 64),
  avif: pad(u8([0, 0, 0, 0x1c], "ftypavif", [0, 0, 0, 0], "avifmif1miaf"), 64),
  heic: pad(u8([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic"), 64),
  pdf: u8("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n"),
  zip: pad(u8([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), 64),
  gzip: pad(u8([0x1f, 0x8b, 0x08, 0x00]), 32),
  mp4: pad(u8([0, 0, 0, 0x18], "ftypisom", [0, 0, 2, 0], "isomiso2"), 64),
  mov: pad(u8([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 2, 0], "qt  "), 64),
  webm: pad(u8([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), 64),
  mp3: pad(u8("ID3", [3, 0, 0, 0, 0, 0, 0]), 64),
  wav: pad(u8("RIFF", [0x24, 0, 0, 0], "WAVEfmt "), 64),
  ogg: pad(u8("OggS", [0, 2]), 64),
};

export const pngBytes = (size = 64): Buffer => Buffer.from(pad(fixtures.png, size));
