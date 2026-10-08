import type { Root } from 'hast';
import { fromParse5 } from 'hast-util-from-parse5';
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5';

export type Parse5Node = DefaultTreeAdapterMap['node'];

/**
 * Removes every `template` element that parse5 made in a foreign namespace (inside `svg` or
 * `math`: directly, or in `g`, `defs`, ...). Only an HTML `template` has a `content` fragment, and
 * `hast-util-from-parse5` throws when it reads the missing one. An HTML `template` keeps its
 * content, which is searched too, and is dropped later by the allow-lists. True when one was
 * removed. Splices in place, so a tree without a foreign `template` is not copied.
 */
function dropForeignTemplates(node: Parse5Node): boolean {
  let dropped = false;
  if ('content' in node && dropForeignTemplates(node.content)) dropped = true;
  if ('childNodes' in node) {
    for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
      const child = node.childNodes[i];
      if (!child) continue;
      if (child.nodeName === 'template' && !('content' in child)) {
        node.childNodes.splice(i, 1);
        dropped = true;
      } else if (dropForeignTemplates(child)) dropped = true;
    }
  }
  return dropped;
}

/**
 * Markup as a hast fragment, parsed the way `rehype-parse` does it (`fragment` mode, no
 * scripting) but with foreign `template`s removed first, so it does not throw on them. Uses the
 * same `parse5` that `rehype-parse` resolves; keep their versions together. `templateRemoved` is
 * true when one was removed from the first top-level node that `keep` accepts (every node when
 * `keep` is not given).
 */
export function parseHtmlFragment(
  html: string,
  space: 'html' | 'svg' = 'html',
  keep?: (node: Parse5Node) => boolean,
): { tree: Root; templateRemoved: boolean } {
  const fragment = parseFragment(html, { scriptingEnabled: false });
  const dropped = new Set<Parse5Node>();
  if (/template/i.test(html)) {
    for (const child of fragment.childNodes) if (dropForeignTemplates(child)) dropped.add(child);
  }
  const kept = keep && fragment.childNodes.find(keep);
  const templateRemoved = kept ? dropped.has(kept) : !keep && dropped.size > 0;
  return { tree: fromParse5(fragment, { space }) as Root, templateRemoved };
}
