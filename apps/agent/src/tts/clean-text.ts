/**
 * Strips markdown so it isn't read aloud literally (asterisks, list markers,
 * headings, links…). Applied to each chunk before synthesis. Note chunks can
 * split a `**bold**` across a boundary, so a final pass removes any stray
 * markdown characters too.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet lists
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered lists
    .replace(/[*_`~]/g, '') // stray markers left by chunk splits
    .replace(/[ \t]{2,}/g, ' ') // collapse spaces
    .replace(/\n{2,}/g, '\n') // collapse blank lines
    .trim();
}
