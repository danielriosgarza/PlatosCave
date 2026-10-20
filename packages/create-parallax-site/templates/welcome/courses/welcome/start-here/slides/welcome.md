# Welcome to Parallax

This course is a sample that comes with every new site. Each tab of this topic shows one kind of material, and each comes from one file in the course folder.

Move through the deck with **Next** and **Previous**, or with the arrow keys.

---

# Five tabs in every topic

- **Slides**: a deck like this one, written in Markdown, or a PDF
- **Reading**: a text in Markdown, HTML or PDF, with notes in the margin
- **Exercises**: short steps with hints, feedback and a solution
- **Notebooks**: Jupyter notebooks with their outputs and data files
- **Tests**: questions with points, attempts and results

---

# One folder per topic

```text
courses/welcome/
  course.yaml            the title, and public: true or false
  start-here/
    topic.yaml           the topic and the list of its resources
    slides/welcome.md    this deck
    reading/guide.md
    notebooks/demo.ipynb
```

A public course keeps its exercises and tests in `private/`, which git ignores.

---

# Three levels

| Level | Needs | Students get |
| --- | --- | --- |
| 0, open site | two static hosts | slides, readings and notebooks, without signing in |
| 1, class | a server with sign-in | exercises, tests, notes, discussion and review |
| 2, code checks | a runner on a host of its own | code questions that run and are graded |

Set `level` in `parallax.config.ts`.

---

# Writing a deck

A line that holds only `---` starts the next slide. Headings, lists, tables, code and mathematics work: the mean is $\bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i$.

Images are not shown in a Markdown deck, so describe a diagram in words. A PDF in `slides/` is a deck too: export one from any presentation program.
