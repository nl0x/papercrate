import { generateRandomTagColor } from './utils/colors';

class TagManager {
  constructor({ colorGenerator = generateRandomTagColor } = {}) {
    this.colorGenerator = typeof colorGenerator === 'function' ? colorGenerator : generateRandomTagColor;
  }

  normalizeLabel(label) {
    if (typeof label !== 'string') {
      return '';
    }
    return label.trim();
  }

  buildPayload({ label, color } = {}) {
    const normalizedLabel = this.normalizeLabel(label);
    if (!normalizedLabel) {
      throw new Error('Tag label is required.');
    }
    const payload = { label: normalizedLabel };
    const trimmedColor = typeof color === 'string' && color.trim().length ? color.trim() : null;
    payload.color = trimmedColor || this.colorGenerator();
    return payload;
  }
}

export default TagManager;
