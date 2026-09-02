import { normalizeUrl } from './url.js';

export interface LlmsTxtLink {
  /** The `## Section` heading this link appeared under. '' when before any heading. */
  section: string;
  /** Markdown link text. */
  title: string;
  url: string;
  /** 1-based line number in llms.txt, so a report can point at the exact line to fix. */
  line: number;
}

export interface LlmsTxtDoc {
  links: LlmsTxtLink[];
  sections: string[];
}

const MD_LINK = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// The lookbehind keeps this from re-matching the URL inside a markdown link, which
// MD_LINK has already claimed.
const BARE_URL = /(?<![([<])\bhttps?:\/\/[^\s<>()[\]"']+/g;

/**
 * Parses an llms.txt (markdown) into its links, tagged with the section they live under.
 *
 * Both markdown links and bare URLs count — the file is hand-written, so it contains both.
 * The section tag matters for the drift report: "3 dead links, all under Blog" is
 * actionable in a way that "3 dead links" is not.
 */
export function parseLlmsTxt(text: string, baseUrl?: string): LlmsTxtDoc {
  const links: LlmsTxtLink[] = [];
  const sections: string[] = [];
  let section = '';

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = (heading[1] ?? '').trim();
      // Only `##` and deeper are real sections; `#` is the document title.
      if (line.startsWith('##') && title) {
        section = title;
        if (!sections.includes(title)) sections.push(title);
      }
      continue;
    }

    const seenOnLine = new Set<string>();

    MD_LINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK.exec(line)) !== null) {
      const url = normalizeUrl(m[2] ?? '', baseUrl);
      if (!url || seenOnLine.has(url)) continue;
      seenOnLine.add(url);
      links.push({ section, title: (m[1] ?? '').trim(), url, line: i + 1 });
    }

    BARE_URL.lastIndex = 0;
    while ((m = BARE_URL.exec(line)) !== null) {
      const url = normalizeUrl(m[0]);
      if (!url || seenOnLine.has(url)) continue;
      seenOnLine.add(url);
      links.push({ section, title: '', url, line: i + 1 });
    }
  }

  return { links, sections };
}
