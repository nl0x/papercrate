const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const gammaEncode = (channel) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;

const oklchToHex = (l, c, h) => {
  const hr = (h * Math.PI) / 180;
  const a = Math.cos(hr) * c;
  const b = Math.sin(hr) * c;

  const l1 = l + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = l - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l1 ** 3;
  const m3 = m1 ** 3;
  const s3 = s1 ** 3;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  if ([r, g, bLin].some((channel) => channel < 0 || channel > 1)) {
    return null;
  }

  const sr = Math.round(clamp01(gammaEncode(r)) * 255);
  const sg = Math.round(clamp01(gammaEncode(g)) * 255);
  const sb = Math.round(clamp01(gammaEncode(bLin)) * 255);

  return `#${((sr << 16) | (sg << 8) | sb).toString(16).padStart(6, '0')}`;
};

const hslToHex = (h, s, l) => {
  const normalizedH = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);

  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hPrime = normalizedH / 60;
  const x = chroma * (1 - Math.abs((hPrime % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hPrime >= 0 && hPrime < 1) {
    r1 = chroma;
    g1 = x;
  } else if (hPrime >= 1 && hPrime < 2) {
    r1 = x;
    g1 = chroma;
  } else if (hPrime >= 2 && hPrime < 3) {
    g1 = chroma;
    b1 = x;
  } else if (hPrime >= 3 && hPrime < 4) {
    g1 = x;
    b1 = chroma;
  } else if (hPrime >= 4 && hPrime < 5) {
    r1 = x;
    b1 = chroma;
  } else {
    r1 = chroma;
    b1 = x;
  }

  const m = light - chroma / 2;
  const r = clamp01(r1 + m);
  const g = clamp01(g1 + m);
  const b = clamp01(b1 + m);

  const sr = Math.round(r * 255);
  const sg = Math.round(g * 255);
  const sb = Math.round(b * 255);
  return `#${((sr << 16) | (sg << 8) | sb).toString(16).padStart(6, '0')}`;
};

export const hexToRgb = (input) => {
  if (!input) return null;
  const match = HEX_COLOR_PATTERN.exec(input.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    hex: `#${match[1].toLowerCase()}`,
  };
};

export const relativeLuminance = ({ r, g, b }) => {
  const toLinear = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };

  const [red, green, blue] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const getReadableTextColor = (hex, { light = '#1f1f1f', dark = '#ffffff' } = {}) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return dark;
  const luminance = relativeLuminance(rgb);
  return luminance > 0.6 ? light : dark;
};

export const getTagColorStyle = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return {
    backgroundColor: rgb.hex,
    borderColor: rgb.hex,
    color: getReadableTextColor(rgb.hex),
  };
};

export const generateRandomTagColor = () => {
  const bucketCount = 8;
  const bucketWidth = 360 / bucketCount;
  const bucket = Math.floor(Math.random() * bucketCount);
  const baseHue = bucket * bucketWidth;
  const hueJitter = bucketWidth * 0.35;
  const hue = baseHue + (Math.random() * 2 - 1) * hueJitter;
  const saturation = 0.45 + Math.random() * 0.2; // 0.45 - 0.65
  const lightness = 0.55 + Math.random() * 0.1; // 0.55 - 0.65
  return hslToHex(hue, saturation, lightness);
};

export { HEX_COLOR_PATTERN };
