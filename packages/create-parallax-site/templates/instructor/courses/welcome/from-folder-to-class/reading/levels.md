# Levels, sync and classes

`level` in `parallax.config.ts` says how much of Parallax the site runs. A site moves between levels by changing that one value and running the commands of the new level.

| Level | Runs | Students can |
| --- | --- | --- |
| 0, open site | nothing but two static hosts | read slides, readings and notebooks without signing in; Exercises and Tests list titles only |
| 1, class | a server, PostgreSQL and sign-in, on one host with Docker | sign in, join a class, work exercises and tests, keep notes, ask questions and connect notebooks |
| 2, code checks | level 1 and a runner on a host of its own | run code questions and have them graded |

## Level 0: an open site

```text
npx parallax build
```

The build writes `dist/site` for the host of `origins.app` and `dist/content` for the host of `origins.content`. It leaves out every exercise and test definition and every resource marked `visibility: hidden`, so `private/` never reaches the hosts.

## Level 1: a class

The first start, in order:

1. `npx parallax start` writes the secrets into `.env`, builds the site and starts its services.
2. The instructor of `instructor.yaml` signs in once in the browser.
3. `npx parallax sync` turns each course folder into a course and publishes it as a release.
4. `npx parallax apply` creates the classes that `classes` in `parallax.config.ts` names, gives each the course's newest release, and prints each class's enrolment code once. Students join with that code.

After a change to a course folder, run `npx parallax sync` again: it publishes a new release, and a class keeps the release it has until an instructor adopts the new one. Nothing writes back into the folder: if a file was last changed in the editor, `sync` stops and names it, so that the folder's version does not replace the editor's by accident.

## Level 2: code checks

Add `runner` to `parallax.config.ts`: the runner host's address, this host's address on the network between them, and the runtimes. The test of the first topic has a commented code question that shows what a runner grades.
