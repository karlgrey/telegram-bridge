// Live-Fund bridge.log 27.07.2026: Texte mit unpaired Surrogates (z. B. \udcbb aus
// surrogateescape-dekodierten kaputten Bytes eines externen Hooks via POST /notify)
// erreichen sendMessage und Telegram lehnt mit "400: Bad Request: strings must be
// encoded in UTF-8" ab — der Push geht verloren. Diese Funktion macht den Text
// UTF-8-sicher, bevor er die Telegram-API erreicht.

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
const REPLACEMENT_CHAR = '�';

/**
 * Ersetzt jeden UNPAIRED Surrogate-Codepoint (High-Surrogate ohne folgendes Low,
 * Low-Surrogate ohne vorangehendes High) durch U+FFFD. Gültige Surrogate-Paare
 * (z. B. Emojis wie 😀) bleiben unangetastet.
 */
export function sanitizeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX) {
      const next = text.charCodeAt(i + 1);
      if (next >= LOW_SURROGATE_MIN && next <= LOW_SURROGATE_MAX) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += REPLACEMENT_CHAR;
      }
    } else if (code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX) {
      out += REPLACEMENT_CHAR;
    } else {
      out += text[i];
    }
  }
  return out;
}
