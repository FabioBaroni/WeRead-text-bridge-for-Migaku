# WeRead-text-bridge-for-Migaku
Read WeRead books with Migaku!

Hey everyone! I made a Tampermonkey script to help Migaku work with Chinese books on WeChat Read / WeRead (微信读书).
WeRead renders book text on a canvas, so Migaku could parse the interface but miss the actual book. The script captures that text and puts it in an integrated reading view that Migaku can parse.

Features:
Migaku dictionary lookup, pinyin, and word-status highlighting.
Automatic text updates when turning pages.
Joins words split across printed lines.
Adjustable text size, spacing, and width.
Copy a sentence with its book/chapter title and source link.
Keeps the page controls accessible.

Setup:
Install Tampermonkey in Chrome.
Install the script from the link below.
Open or reload a WeRead book.
If needed, trigger Migaku’s normal page-parsing command.

Experimental extras:
Analyse vocabulary: moves through accessible pages and estimates known-word coverage using Migaku’s word statuses. Learning words stay separate; this isn’t a guarantee of comprehension.
Save as EPUB: independently captures accessible text across chapters, with reconstructed chapter sections and a table of contents. Interrupted captures are labelled partial. Download before closing or reloading the tab.
These extras have worked in testing, but may still have bugs. Formatting and chapter boundaries are reconstructed, and EPUBs don’t include illustrations or cover artwork.
Whole books may require a WeRead subscription or purchase. The script only reads content you can already access and doesn’t bypass restrictions.
This is a personal project, not an official Migaku integration. Feedback and bug reports are welcome!
