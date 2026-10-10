# Student guide

This guide covers what a student can do in Parallax today. It names the buttons and headings you will see. For installing or running the app, see [getting-started.md](../getting-started.md). For the full rules behind each feature, follow the links to the [product specification](../product-spec.md).

## Sign in

1. Open the app. If you are not signed in, you land on **Sign in**.
2. Choose **Student sign in**.
3. Enter your **Email address**. Use the address on your invitation.
4. Select **Send sign-in link**.
5. Open the link in the email.

The page then says **Sign-in link requested**. A link works once and expires after 15 minutes. If you open a used or old link, you see **This sign-in link no longer works**. Request a new one on the same page.

If you were sent to sign in from a link inside the app, you return to that page after signing in.

To leave, select **Sign out** in the top bar. Unsent notes kept on this device are cleared when you sign out.

Details: [spec section 3](../product-spec.md#3-sign-in-and-permissions).

## Join a class

Your instructor gives you an enrolment code.

- A new account with no classes shows **Join a class** on **Your courses**. Type the code in **Invitation code** and select **Join class**.
- If you already have classes, select **Join a class** at the top of **Your courses**. A dialog opens with the same field.

After joining, a message says **You joined** the course and class. Select **Open the course** to go to its topics. If you are already in the class, the message says so.

A code can fail. The message tells you why:

- the code is not valid
- the instructor withdrew it
- it has expired
- the class has reached its enrolment limit
- the class is archived and takes no new students

An instructor account holder who also studies can switch between **Student view** and **Instructor view** on the courses page. This guide covers the student view only.

Details: [spec section 4](../product-spec.md#4-course-and-topic-selection).

## Find courses and topics

### Your courses

**Your courses** shows one card per course. Each card shows the topic count, your class name and how many topics you have reviewed, such as "2 of 5 reviewed".

- Select the card to open the topic list.
- Select **Resume** on a card to go back to the resource you were last using. A card with no saved place says **Not started**.
- If you are in several classes of one course, the card shows **Choose class**.
- Use the filters **All**, **In progress** and **Archived**, or **Search** by course title.
- Archived classes stay readable.

### Topic list

The topic list is a table with the columns **No.**, **Topic**, one column each for Slides, Reading, Exercises, Notebooks and Tests, **Time** and **Status**.

- A filled dot means that material exists for the topic. An empty dot means none has been added.
- The current topic has a **Resume** link in its status cell, or **Start** if you have no saved place.
- A topic that is not open yet shows why: **Opens** with a date, or **Requires** with the topics you must finish first. You cannot open it.
- A finished topic shows **Reviewed**.
- The footer shows the count of reviewed topics.

Select a topic title to open it. Use **Topics** in the top bar to come back to the list. In a topic, the top bar also has links to the previous and next topic.

### Download my annotations

See [Download your own data](#download-your-own-data).

## The topic page

A topic page shows the title, the learning objective, and a line with the course, the topic position, study time, your class and the instructors.

Under it, the tab row **Topic materials** has five tabs: **Slides**, **Reading**, **Exercises**, **Notebooks** and **Tests**. The page remembers your place in each tab. If a tab has nothing, it says so, for example **No reading has been added**.

Two buttons sit in the toolbar above the material:

- **Focus** hides the top bar, heading and tabs. Select **Exit focus** to bring them back. Escape also exits.
- **Full screen** uses the whole browser display. It becomes **Exit full screen**. The F key does the same when you are not typing in a field.

### Reviewed

At the bottom of the topic page, the **Reviewed** section lists the topic's materials. Opening or viewing something does not mark it. For ungraded material, tick the checkbox yourself. For graded work, the list shows whether you have submitted it, and whether it is required for completion. The section says **This topic is complete.** or **This topic is not complete yet.** Reviewing is not a grade.

Details: [spec section 5](../product-spec.md#5-topic-workspace-and-dimensions).

## Slides

Slides can be a PDF deck or web slides.

- **Previous** and **Next** move one slide. The count shows `page / total`. The left and right arrow keys also work when the viewer has focus.
- **Slide index** opens a list of numbered buttons to jump to a slide.
- **Zoom in**, **Zoom out** and **Fit** change the size. When zoomed, the arrow keys pan the slide.
- **Notes** opens the slide margin. **Hide notes** closes it.
- If the deck has an original file, a download button is next to **Next**.

The viewer remembers your last slide.

The slide margin has two tabs, **My notes** and **Discussion**. They work like the reading margin below, tied to the current slide:

- Write a private note for the slide. It shows **Private**.
- Ask a question or comment. See [Posts and questions](#posts-and-questions).

Details: [spec section 7](../product-spec.md#7-slides).

## Reading

A reading is either text or a PDF. If a topic has several readings, pick one in the **Reading** picker. Your place in each is kept.

For a PDF, **Previous page** and **Next page** move between pages. The reader shows **Page N of M**.

**Notes** opens the margin. **Hide notes** closes it. The margin is named **Notes and discussion** and has two tabs: **My notes** and **Discussion**.

If a reading has a source file, you can download it with the button in its toolbar.

### Highlights and notes

Select text in the reading. A small toolbar named **Selected passage** appears with three buttons: **Highlight**, **Note** and **Ask**.

- **Highlight** marks the passage. In **My notes** it appears as **Highlight**. Select **Remove highlight** to take it off.
- **Note** adds a private note on the passage. Type in the note field. Select **Delete note** to remove it. Notes are private to you.
- **Ask** starts a question. See [Posts and questions](#posts-and-questions).

You can also add a topic note with no passage. It appears as **Topic note · no anchor**.

Select an entry in the margin to jump to its passage. Select a mark in the text to open its entry.

A save line shows **Saving**, **Saved**, **Offline · changes on this device** or **Could not save** with a **Retry** button. Notes autosave after a short pause and when you leave the field. If the browser is offline, your text stays on this device until you can save.

If the same note changed elsewhere, a dialog titled **This note changed somewhere else** shows **Your text on this device** and **Saved version**. Choose **Keep my text** or **Use the saved version**.

If a newer version of the reading cannot be matched to your mark, the entry shows **Waiting to be placed** or **Needs reattachment**. Your original quote is kept.

### Drawings

A **Sketch** button appears on figures and on PDF pages. It is not on the text toolbar. If you already drew there, it says **Edit sketch**.

The sketch panel has **Pen**, **Eraser**, colours, **Width**, **Undo** and **Redo**. Select **Done** to save the drawing. A description field lets you explain the drawing in words. **Save description** saves a description without a drawing. Drawings are private to you.

### Posts and questions

**Ask** (and the **Discussion** tab) is the one place to post a comment or question.

1. In **Visible to**, choose **Instructor** or **Class**.
2. Type in **Comment or question**.
3. Select **Post**. If it fails, the button says **Retry** and your text is kept.

Each thread shows who wrote it and its audience, for example "You → Instructor", and **Open** or **Resolved**. In a thread you can:

- **Reply**, or **Reply to this discussion**
- **Edit** your own post (it then shows "Edited") and **Save edit**
- **Delete** your own post. A deleted post stays as a placeholder if replies depend on it.
- **Reopen** a question you asked after it was resolved

You see only the threads your audience allows.

Details: [spec section 8](../product-spec.md#8-reading-notes-highlights-drawings-comments-and-questions).

## Exercises

The **Exercises** tab lists the exercises for the topic. Each shows whether it is **Practice · ungraded** or **For credit** with its points and hint rule. Select **Start** to open one. An exercise that has not opened shows **Opens** with a date and **Locked**.

An exercise is a short list of steps. A step can ask for a number, a choice, an ordering or matching, a short explanation, code, or a value recorded from a simulation.

On each step:

- **Check answer** records your answer and gives feedback. If it is wrong, the page says **Not yet.** and keeps your answer, so you can try again.
- For a written explanation, **Done** saves it. For code, **Save code** saves it. These save your work. They do not grade it.
- For a simulation step, **Record this value** records the value for comparison.
- **Show a hint** and **Show next hint** reveal hints one at a time. **Hide hints** and **Show hints** fold them. The page shows "Hints used: N of M". Hint use is recorded for review.
- **Show solution** reveals the answer. This is recorded. The step is only completed with help; some steps still need your own answer afterwards.
- **Continue** moves to the next step. After the last step, **See summary**.

The summary says **Exercise complete.** It shows how each step was done: independently, with hints, or with the solution shown. Select **Start again** for a new attempt. Earlier attempts are kept.

If an exercise is for credit, the points and the hint rule are shown on the page.

Details: [spec section 9](../product-spec.md#9-interactive-exercises).

## Tests

The **Tests** tab lists the tests for the topic. Select a test to open it.

### Before you start

The **Terms** panel shows the rules for the test:

- number of attempts and which attempt you are on
- duration (**Untimed** or minutes from the start)
- points
- when it opens and closes
- **Your deadline**, if you have one
- late-work rule
- allowed materials
- when results and solutions are released
- which attempt is the **Reported grade**

Terms stay visible while you work. The server decides the deadline. Your browser clock does not.

Select **Start attempt N** to begin. If you cannot start, the page says why. Reasons include that the test has not opened, it has closed, you have used every attempt, or the class is archived. An attempt in progress shows **Resume attempt N** with its start time and deadline.

### Working on a test

- The **Questions** list shows each question as **Answered** or **Unanswered**, with **Flagged** if you ticked **Flag for review**.
- Question types are **Multiple choice**, **Numeric answer**, **Explanation** and **Code implementation**.
- Answers save automatically. A status line shows **Saving…**, **Unsaved changes**, **Saved** with a time, or an error. If saving fails, use **Retry save**. For a long answer or code, **Download what you wrote** keeps a copy on your computer.
- For timed tests, the page shows about how many minutes are left.
- Offline, answers stay in the browser and are marked unsaved.

### Code questions

The editor has line numbers, indentation and keyboard navigation. Tab indents; press Escape and then Tab to leave the editor. **Screen-reader mode** switches to a plain text area.

Select **Run sample tests** to run your saved code on the public sample tests. The result is labelled with a snapshot of your code. If you edit afterwards, the output is marked out of date. A run can be **Queued**, **Running**, cancelled, timed out or finished, and the output shows passed or failed checks with expected and actual values, program output and errors.

Running sample tests does not submit anything. If the test service fails, you see **Run unavailable**. Your code is kept and no attempt is used. You can have two runs active at a time.

### Submit

1. Select **Review submission**. The page lists unanswered questions, flagged questions, any unsaved changes and the deadline.
2. Select **Submit test**. If the server does not confirm it, the button says **Retry submit**. Retrying cannot submit twice.

### Receipt

After the server confirms, the page shows **Test submitted** with:

- the **Submitted** time
- the **Attempt** and **Receipt** numbers
- **Timing**: submitted by you, or by the server at the deadline
- **Received**: the answers the server holds
- **Not received**: questions with no saved answer

If time runs out, the server submits the last saved answers. The page says **Time ran out · your saved answers were submitted**.

You can open a past receipt from **Your attempts** with **Open receipt**.

### Unsent work

Changes made after your last successful save are not part of the submission. The receipt says so and tries to send a copy of them to your instructor. If that fails, the copy stays in this browser.

If your instructor asks for your unsent work, **Your attempts** shows a note, and the receipt offers **Send unsent work**.

### Extensions and extra attempts

Your instructor can give you an extension or an extra attempt. Your **Terms** and **Start attempt** button show the effective values. Students have no screen to request one.

### Results and grades

**Your attempts** shows the state of each attempt:

- **In progress**
- **Submitted**
- **Submitted · being graded**
- **Submitted · awaiting instructor review**
- **Submitted · graded, not yet released**
- **Results released**

A **Reported grade** line shows your points and the rule used (for example, latest or highest attempt). When an attempt is released, select **View feedback for attempt N**. It shows your score, instructor feedback, your answers, correct answers and checks where the release rules allow them. If the instructor adjusted a score, the page says so. Select **Back to attempts** to return.

A test that is graded but not released shows no score. A grading failure and an unsubmitted test have their own messages.

Details: [spec section 11](../product-spec.md#11-tests-including-code-implementation).

## Notebooks

The **Notebooks** tab shows the notebooks for the topic. If there are several, pick one in the **Notebook** picker.

### Reading a notebook

By default you see **Saved outputs**: the notebook as saved, with its stored outputs. Nothing runs.

- **Outline** shows a list of sections.
- **Hide code** and **Show code**, **Hide outputs** and **Show outputs** fold cells.
- A download button gives you the original notebook file.
- Scripts in outputs are removed and never run.

### Work in Colab

Below each notebook is **Work in Colab**. Colab runs on Google's computers, outside Parallax.

1. Download the notebook from the toolbar.
2. Select **Open in Colab** and upload the file there.
3. Save a copy in Drive and work in the copy.
4. Download your result as `.ipynb`.
5. Back in Parallax, choose it under **Notebook file (.ipynb)** and select **Submit notebook**.

Parallax shows a receipt with the time, version, file name, size and checksum. Nothing is graded until you submit.

### Run cells on a computer

The toolbar button that says **Saved outputs** opens **Connect a computer**. This lets you run the cells on a computer you may use. The computer runs Python or R. Parallax is the interface.

**Computers.** A connector program runs on the computer that will run your notebooks. In the list, select **Pair a computer**. Follow the instructions shown with the pairing code, then approve the computer in the list. Download the connector from the releases link in the panel. A computer shows as **Waiting for approval**, **Online** or **Offline**. You can approve, reject, rename or revoke a computer. Revoking does not revoke any SSH account.

**Target.** Under **Where should the notebook run?** choose:

- **This computer**: the computer running the connector.
- **SSH host**: another computer reached over SSH. You give a host, port, account, working directory and a key. A jump host is optional.
- **Class computers**: shown when your instructor published a computer for the class.

You also give a **Connection name**, the **Computer running the connector** and the working directory. You can reuse a **Saved connection**.

Select **Save and test connection**. The **Test** section shows each stage as **Passed**, **Failed**, **Waiting**, or **Checked when you connect**. A first-time host asks you to confirm its key fingerprint. If a host key changed, the connection is stopped until you check it and replace the key. Replacing a key needs a sign-in within the last 15 minutes. Select **Test again** to retest.

**Connect.** The **Connect** section shows the computer, account, working directory and whether Parallax starts a Jupyter server or attaches to one. You can set how long an idle notebook runs and how long the kernel is kept after you close the tab. Select **Connect**. Connecting does not run any cell. This connection can read and change the files that account can.

Details: [spec section 10.3](../product-spec.md#103-set-up-and-connect).

### Running cells

In a connected notebook:

- Each code cell has a **Run** button. The toolbar has **Run all** and **Interrupt**.
- **Run all** stops at the first error.
- The **Session** menu has **Restart kernel**, **Disconnect** and **Stop session**. **Restart kernel** and **Stop session** ask you to confirm. Restarting loses your variables. **Stop session** appears only for a session Parallax started.
- The toolbar shows the computer, language and state, such as "Lab server · Python · Ready". It shows Ready only when the kernel is confirmed.
- You can edit cell code in place. Edits stay if the connection drops, but cells cannot run until you connect again. Parallax does not rerun cells for you.
- If the connection is lost, the page says why and offers **Reconnect to this session** or **Connect a computer**. If the kernel is gone, choose **Start a new kernel**.

Details: [spec section 10.4](../product-spec.md#104-running-cells-and-controlling-a-session).

### Files, save and submit

A connected notebook has a panel named **Files, save and submit**.

**Files.** Browse the working directory on the computer. Select files and choose **Copy selected files to Parallax**. Only files you copy can be submitted. If a file already exists with different content, a dialog asks you to choose **Keep theirs** or **Replace with mine**.

**Save.**

- **Save to Parallax** stores your working copy in Parallax.
- **Download .ipynb** gives you the notebook file.
- **Save to computer** writes the notebook into the working directory. Enter a **File name in the workspace**, ending in `.ipynb`.

**Submit.** **Submit notebook** freezes the notebook and the files you tick under **Files copied to Parallax to include**. Later changes are not part of it. Your instructor sees the frozen copy, not your computer.

Details: [spec section 10.5](../product-spec.md#105-files-saving-and-submission).

### Shiny apps

A Shiny app opens in a frame in the Notebooks tab. The frame shows **Loading app**, **App reported ready** or **No ready message from the app**. Use **Restart** to reload it and **Open externally** to open it in its own tab. Without a live session, it shows **Preview · no session**. An app shown here does not by itself record a grade.

## Download your own data

On the topic list for a class, select **Download my annotations**. This downloads a JSON file with your own notes, highlights, sketches and posts in that class. It names the resources and where each mark sits. Sketches are readable as SVG. It does not contain anyone else's notes. The page confirms how many annotations and posts the file holds. If you are in two classes, download each separately. It works in archived classes too.

The server also has routes to deactivate or delete your own account (`/api/me/deactivate` and `/api/me/delete`). The web app has no screen for them. Account closure and retention are described in [spec section 13](../product-spec.md#13-data-and-service-boundaries) and [operations.md](../operations.md).
