# Make the site your own

A Parallax site is a folder: one configuration file, the site's own pages, and one folder for each course. This reading walks through the files of a new site in the order you are likely to change them. Every command here runs in the site folder.

| File or folder | Holds |
| --- | --- |
| `parallax.config.ts` | the site's name, logo, level, host names, sign-in and classes |
| `instructor.yaml` | the instructor's name and email address (in a school site, one in each folder under `instructors/`) |
| `src/pages/` | the site's own pages: `index.tsx` is the front page |
| `courses/` | one folder for each course, such as this one, `courses/welcome/` |
| `private/` | the exercises and tests of public courses; git ignores it |

## Edit parallax.config.ts

The template's values are samples on `example.org`. Before the first start, replace:

- `name`, which the front page shows as its title;
- `origins`: the two host names of the site, `app` for the application and `content` for the files students open (they must differ);
- `signIn`: the sender address of the sign-in emails, or the sign-in providers;
- `classes`: each class names the folder of its course, such as `{ course: 'welcome', name: 'Spring 2027' }`.

To show a logo, put a PNG, JPEG or WebP file in `src/` and uncomment the `logo` line. Change your email address in `instructor.yaml` too: the account with that address owns the site's courses.

## Change the front page

`src/pages/index.tsx` is the page at `/`. It receives the site's name, its logo and the courses found when the site is built. The turning solids under the title is `src/pages/_visualization.tsx`. You can:

- change the constants at the top of that file: the speed, the stations, their labels and the pixel drawings, or `SEED` for other mountains and rocks;
- write your own component in that file, such as a plot or a small simulation, and export it as its default;
- delete the import of `Visualization` and its element from `index.tsx` to show no scene at all.

A file in `src/pages/` whose name starts with `_` is a helper, not a page. Any other `.tsx` file is a page of its own: `src/pages/about.tsx` is at `/about`. Styles go in `*.module.css` files next to the pages. A site stylesheet may use the `--pc-*` colours and sizes of Parallax but not set them, every selector names a class, and `:global` and `@import` are refused, so a page cannot change how Parallax's own screens look.

## Describe a course and its topics

A course folder holds `course.yaml` and one folder for each topic.

```yaml
# courses/welcome/course.yaml
title: Welcome to Parallax
public: true
```

`public: true` means the course folder may be published, so its exercises and tests lie in `private/` at the same path: `private/courses/welcome/start-here/exercises/`. With `public: false` they lie in the topic folder, beside the other three tabs.

Each topic folder holds `topic.yaml`:

```yaml
id: 86c5d566-494a-46d0-afed-0d0ee178a917
position: 0
title: How a Parallax course works
objective: Find each of the five kinds of material and the file it comes from.
estimatedMinutes: 30
resources:
  - id: 1a9974f3-729f-4feb-9718-c1476a79ef41
    file: slides/welcome.md
    title: Parallax in five slides
```

Topics are shown in the order of their `position`, and resources in the order of `resources`. Leave out `id` when you add a topic or a resource and run:

```text
npx parallax check --write-ids
```

It writes a new id for every entry that has none and changes nothing else. Keep an id once it is written: it is how Parallax recognises the resource after a rename.

## Put each file in its tab

| Tab folder | Files |
| --- | --- |
| `slides/` | a Markdown deck (`.md`) or a PDF |
| `reading/` | Markdown, HTML or PDF |
| `notebooks/` | a Jupyter notebook (`.ipynb`), with its data files in a folder of the same name; or a Shiny app as `.shiny.yaml` |
| `exercises/` | an exercise as YAML |
| `tests/` | a test as YAML, with the files of its code questions in a folder of the same name |

Every file of a tab folder must be listed in `topic.yaml`, and every listed file must exist. Open the exercises and the test of this topic in `private/` to see their formats: each holds comments that explain its fields. `interactive-tour.yaml` has one step of each kind a learner answers by dragging, drawing or moving a diagram.

## Check and preview

```text
npx parallax check     # reports each problem in the course folders
npx parallax dev       # serves the site's pages and reloads them when you save
npx parallax build     # writes the site into dist/
```

The next topic, **From a folder to a class**, explains the three levels and how a course reaches a class.
