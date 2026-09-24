# Library Book Review

A web app where library staff submit books for board review, backed by the Knack app **Library Review** (`6ab2ddba6dd859465f1b298e`). It's plain HTML and JavaScript with no build step and no server, so any static host works (GitHub Pages, district web server, and so on).

## What it does

**Librarians**
- **Add a book**: scan or type an ISBN. The app:
  - validates the check digit and converts ISBN-10 to ISBN-13;
  - fills in the title, author and date from Google Books or Open Library;
  - finds the ISBNs of other editions automatically.
- **Duplicate blocking**: an entry is rejected if its ISBN, or any of its alternate ISBNs, is already on another book. The app warns (but doesn't block) when:
  - the same title exists under a different ISBN;
  - Open Library groups the book with one that's already submitted.
- **Add many**: upload the old order spreadsheet (.xlsx/.csv) or paste rows from Excel. The app checks every row for bad ISBNs, duplicates within the file and duplicates already in the system, then submits the rows that pass.
- **My submissions**: see your submissions with their status and any review conditions. You can edit or withdraw a book until it's sent for review.
- **Search all books**: search by title, author or any ISBN before submitting.

**Admins**
- **Review books**: filter by board meeting, status, campus or text. The page shows status counts. Change a status inline or for several books at once. Open a book to edit it, manage its ISBNs or delete it.
- **Send to Luma**: download a CSV in Luma's column order (ISBN | Title | Authors | Date Published), then mark those books "Sent to Luma".
- **Import Luma results**: upload Luma's export (.xlsx/.csv). The app:
  - matches rows on any known ISBN, falling back to title;
  - lets you map Luma's review statuses onto this app's statuses;
  - saves the conditions, booklist and other result fields.

**Everyone**
- Works on phones: tables turn into stacked cards on narrow screens.
- Book covers (from Open Library) in every list and table. A book without a cover shows a colored tile with its first letter. Open Library limits cover lookups to about 100 per 5 minutes per network, so covers only load for rows on screen. If many fail in a row, the app stops requesting covers for 5 minutes and shows tiles instead.
- **Row menu (⋯)** on every book in *Review books*, *My submissions* and *Search all books*:
  - **Refresh book data** looks the ISBN up again in Google Books and Open Library. It shows which details differ and which other-edition ISBNs aren't saved yet, and lets you apply the ones you tick. Admins can apply changes to any book. Librarians can apply them to their own books while they're still *Submitted*; for other books they can only look.
  - **View raw data** opens a new tab with the Knack book record, its ISBN records, and the raw Google Books and Open Library responses. Each section can be copied, and everything can be downloaded as one `.json` file. Pop-ups must be allowed for the site.
- Light/dark theme toggle in the top bar. It follows the device setting until someone picks a theme, and the choice is remembered in that browser.

**API usage:** the status counts on *Review books* and *My submissions* come from one Knack aggregate request, which is only repeated when the board meeting changes or after a bulk update. Changing a single book's status updates the counts on the page without calling the API again.

## Deploying on GitHub Pages
1. Create a **public** repo (e.g. `library-review`).
2. Upload the *contents* of this folder: `index.html`, `css/`, `js/`, `auth/`.
3. Go to **Settings → Pages** and choose **Deploy from a branch**, then `main` and `/ (root)`.
4. Site URL: `https://<username>.github.io/library-review/`.

**Changing the web address:** Knack only sends people back after sign-in to addresses registered in advance. Register the new address with `/auth/callback/` on the end (e.g. `https://<username>.github.io/library-review/auth/callback/`), then put the client ID into `CLIENT_ID` in `js/config.js`.

## Day-to-day admin (in the Knack builder)
- **Approve librarians**: new librarians choose *Sign up* on the sign-in page. Approve them in **Roles → Librarians** by setting User Status to *active*, and set their **Campus** so the submit form defaults to it.
- **Create admins**: add a record under **Roles → Admins**. Self sign-up is off for admins.
- **Add a board meeting or campus**:
  1. Add the option to the *Board Meeting* or *Campus* field on the **Books** table (also *Campus* on **Librarians**).
  2. Add it to `BOARD_MEETINGS` / `CAMPUSES` in `js/config.js`, and update `DEFAULT_BOARD_MEETING`.
  3. Re-upload `js/config.js` to GitHub.

## Data model (Knack)
| Table | Purpose |
|---|---|
| Books | One row per requested title: status, board meeting, campus, age level, Luma results |
| ISBNs | Every ISBN (primary and alternates) with a **unique** rule, linked to its book. This is what makes duplicate blocking reliable. |
| Librarians / Admins | User roles. Librarians can read all books (for duplicate checks) but edit only their own. |

## Notes
- The online lookups use Google Books and Open Library. If the district web filter blocks them, staff can still type the details; duplicate checks don't depend on them.
- Luma's exact "Review Status" wording isn't known yet. The import screen guesses a mapping and you can change it before saving.
- Developer tests: `node --test tests/logic.test.mjs`.
