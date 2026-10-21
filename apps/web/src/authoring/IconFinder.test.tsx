import { describe, expect, it } from 'vitest';
import { findIcons } from './IconFinder';
import { ICON_TAGS } from './iconTags.gen';

const first = (query: string, count = 3) => findIcons(query, ICON_TAGS).slice(0, count);

describe('finding an icon', () => {
  it('A42 lists the icons named by a word before those that only contain it', () => {
    expect(first('tree')).toEqual(['tree-palm', 'tree-pine', 'tree-deciduous']);
    const trees = findIcons('tree', ICON_TAGS);
    expect(trees.indexOf('tree-pine')).toBeLessThan(trees.indexOf('list-tree'));
    expect(first('triangle', 1)).toEqual(['triangle']);
    expect(first('alert circle', 1)).toEqual(['circle-alert']);
    expect(findIcons('  ', ICON_TAGS)).toEqual([]);
  });

  it('A42 finds an icon by its older name or a search word before names that only contain the word', () => {
    // `home` is the older name of house; dock and lamp have it only as a search word.
    expect(first('home', 1)).toEqual(['house']);
    // `edit` is an older name of the pens; credit-card only contains the word.
    const edits = findIcons('edit', ICON_TAGS);
    expect(edits[0]).toBe('pen');
    expect(edits.indexOf('square-pen')).toBeLessThan(edits.indexOf('credit-card'));
    // A search word alone finds an icon: a dog's bone.
    expect(findIcons('dog', ICON_TAGS)).toContain('bone');
  });
});
